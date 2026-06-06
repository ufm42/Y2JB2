//#region Constants
const RTP_SET = 1;
const MAIN_CORE = 7;
const CPU_WHICH_TID = 1;
const CPU_LEVEL_WHICH = 3;
const RTP_PRIO_REALTIME = 2;

const COMMAND_IDLE = -1;
const COMMAND_STOP = -2;

fn.pthread_cond_broadcast = new NativeFunction(eboot_base + 0x215e160n, "number");
fn.pthread_cond_destroy = new NativeFunction(eboot_base + 0x215e1b0n, "number");
fn.pthread_cond_init = new NativeFunction(eboot_base + 0x215e190n, "number");
fn.pthread_cond_wait = new NativeFunction(eboot_base + 0x215e1d0n, "number");
fn.pthread_mutex_destroy = new NativeFunction(eboot_base + 0x215e220n, "number");
fn.pthread_mutex_init = new NativeFunction(eboot_base + 0x215e210n, "number");
fn.pthread_mutex_lock = new NativeFunction(eboot_base + 0x215e1f0n, "number");
fn.pthread_mutex_unlock = new NativeFunction(eboot_base + 0x215e230n, "number");

fn.rtprio_thread = new NativeFunction(0x1d2, "number");
fn.cpuset_setaffinity = new NativeFunction(0x1e8, "number");
//#endregion
//#region Classes
class Worker {
  constructor(input) {
    if (typeof input === "bigint") {
      this.can_free = false;
      this.ctx = worker_ctx.new(input);
    } else if (typeof input === "number") {
      this.can_free = true;

      this.ctx = worker_ctx.new();
      this.ctx.cmd = COMMAND_IDLE;
      this.ctx.total = input;

      this.ctx.mutex = mem.alloc(8);
      this.ctx.cond = mem.alloc(8);

      if (fn.pthread_mutex_init.invoke(this.ctx.mutex, 0)) {
        throw new Error("Unable to create mutex");
      }

      if (fn.pthread_cond_init.invoke(this.ctx.cond, 0)) {
        throw new Error("Unable to create cond");
      }
    } else {
      throw new Error("Input type not supported !!");
    }
  }

  free() {
    if (this.can_free) {
      if (fn.pthread_mutex_destroy.invoke(this.ctx.mutex)) {
        throw new Error("Unable to destroy mutex");
      }

      if (fn.pthread_cond_destroy.invoke(this.ctx.cond)) {
        throw new Error("Unable to destroy cond");
      }

      mem.free(this.ctx.mutex);
      mem.free(this.ctx.cond);
      mem.free(this.ctx.addr);
    }
  }

  signal_work(cmd) {
    if (fn.pthread_mutex_lock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to lock mutex ${this.ctx.mutex} !!`);
    }

    this.ctx.cmd = cmd;
    this.ctx.started = 0;
    this.ctx.finished = 0;

    if (fn.pthread_cond_broadcast.invoke(this.ctx.cond)) {
      throw new Error(`Unable to broadcast cond ${this.ctx.cond} !!`);
    }

    while (this.ctx.started < this.ctx.total) {
      if (fn.pthread_cond_wait.invoke(this.ctx.cond, this.ctx.mutex)) {
        throw new Error(`Unable to wait for cond ${this.ctx.cond} !!`);
      }
    }

    if (fn.pthread_mutex_unlock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to unlock mutex ${this.ctx.mutex} !!`);
    }
  }

  wait_for_work() {
    if (fn.pthread_mutex_lock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to lock mutex ${this.ctx.mutex} !!`);
    }

    while (this.ctx.cmd === COMMAND_IDLE || this.ctx.finished !== 0) {
      if (fn.pthread_cond_wait.invoke(this.ctx.cond, this.ctx.mutex)) {
        throw new Error(`Unable to wait for cond ${this.ctx.cond} !!`);
      }
    }

    this.ctx.started++;

    if (this.ctx.started === this.ctx.total) {
      if (fn.pthread_cond_broadcast.invoke(this.ctx.cond)) {
        throw new Error(`Unable to signal cond ${this.ctx.cond} !!`);
      }
    }

    const cmd = this.ctx.cmd;

    if (fn.pthread_mutex_unlock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to unlock mutex ${this.ctx.mutex} !!`);
    }

    return cmd;
  }

  signal_finished() {
    if (fn.pthread_mutex_lock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to lock mutex ${this.ctx.mutex} !!`);
    }

    this.ctx.finished++;

    if (this.ctx.finished === this.ctx.total) {
      if (fn.pthread_cond_broadcast.invoke(this.ctx.cond)) {
        throw new Error(`Unable to signal cond ${this.ctx.cond} !!`);
      }
    }

    if (fn.pthread_mutex_unlock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to unlock mutex ${this.ctx.mutex} !!`);
    }
  }

  wait_for_finished() {
    if (fn.pthread_mutex_lock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to lock mutex ${this.ctx.mutex} !!`);
    }

    while (this.ctx.finished < this.ctx.total) {
      if (fn.pthread_cond_wait.invoke(this.ctx.cond, this.ctx.mutex)) {
        throw new Error(`Unable to wait for cond ${this.ctx.cond} !!`);
      }
    }

    this.ctx.cmd = COMMAND_IDLE;

    if (fn.pthread_mutex_unlock.invoke(this.ctx.mutex)) {
      throw new Error(`Unable to unlock mutex ${this.ctx.mutex} !!`);
    }
  }
}
//#endregion
//#region Functions
function pin_to_core(core) {
  const mask = cpuset.new();

  mask.bits[0] = (1 << core).bigint();

  if (fn.cpuset_setaffinity.invoke(CPU_LEVEL_WHICH, CPU_WHICH_TID, -1, cpuset.sizeof, mask.addr)) {
    throw new SyscallError(`Unable to setaffinity to core ${core}`);
  }

  mem.free(mask.addr);
}

function set_rtprio(value) {
  const prio = rtprio.new();

  prio.type = RTP_PRIO_REALTIME;
  prio.prio = value;

  if (fn.rtprio_thread.invoke(RTP_SET, 0, prio.addr)) {
    throw new SyscallError(`Unable to set priority to ${value}`);
  }

  mem.free(prio.addr);
}
//#endregion
//#region Structs
const cpuset = new Struct("cpuset", [{ type: "Uint64", name: "bits", count: 2 }]);

const rtprio = new Struct("rtprio", [
  { type: "Uint16", name: "type" },
  { type: "Uint16", name: "prio" },
]);

const worker_ctx = new Struct("worker_ctx", [
  { type: "Int32", name: "cmd" },
  { type: "Int32", name: "total" },
  { type: "Int32", name: "started" },
  { type: "Int32", name: "finished" },
  { type: "Uint64", name: "mutex" }, // modified only in main thread
  { type: "Uint64", name: "cond" }, // modified only in main thread
]);
//#endregion

try {
  pin_to_core(MAIN_CORE);
  set_rtprio(0x100);
} catch (e) {
  logger?.error(e.stack);
  mem.free_all();
  throw e;
}
