const SERVER_IP = "192.168.1.2"; // server.js IP
const SERVER_PORT = "4747";

function load_script(src, remote = true) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = remote ? `http://${SERVER_IP}:${SERVER_PORT}/${src}` : src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function fetch_remote(src) {
  return await fetch(`http://${SERVER_IP}:${SERVER_PORT}/${src}`);
}

let userland = "";
let worker = "";
let elfldr = new Uint8Array();
let kexp = new Uint8Array();

async function main() {
  try {
    let res = await fetch_remote("userland.js");
    if (res.ok) {
      userland = await res.text();
    }

    res = await fetch_remote("worker.js");
    if (res.ok) {
      worker = await res.text();
    }

    res = await fetch_remote("kexp.bin");
    if (res.ok) {
      const buf = await res.arrayBuffer();
      kexp = new Uint8Array(buf);
    }

    res = await fetch_remote("elfldr.elf");
    if (res.ok) {
      const buf = await res.arrayBuffer();
      elfldr = new Uint8Array(buf);
    }

    await load_script("ws.js");
    await load_script("logger.js");
    await load_script("userland.js");
    await load_script("env.js");

    if (kexp.length === 0) {
      throw new Error("Empty kexp !!");
    }

    if (elfldr.length === 0) {
      throw new Error("Empty elfldr !!");
    }

    await load_script("thread.js");
    await load_script("worker.js");
    await load_script("kernel.js");
    await load_script("lapse.js");
  } catch (e) {
    logger?.error(e.stack);
  } finally {
    mem.free_all();
  }
}

document.addEventListener("DOMContentLoaded", main);
