const logger = {
  /** @param {string} msg */
  log(msg, screen = true) {
    if (screen) {
      document.body.appendChild(document.createTextNode(msg));
      document.body.appendChild(document.createElement("br"));

      while (document.body.scrollHeight > window.innerHeight) {
        document.body.removeChild(document.body.firstChild);
      }
    }

    ws?.send(msg);
  },
  /** @param {string} msg */
  info(msg) {
    this.log(`[+] ${msg}`);
  },
  /** @param {string} msg */
  error(msg) {
    this.log(`[-] ${msg}`);
  },
  /** @param {string} msg */
  debug(msg) {
    this.log(`[*] ${msg}`, false);
  },
};
