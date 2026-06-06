const env = {
  isolate_addr: 0n,
  splash_screen_addr: 0n,
  browser_module_addr: 0n,
  wrapper_private_addr: 0n,
  main_dom_window_addr: 0n,
  main_web_module_addr: 0n,
  main_web_module_impl_addr: 0n,
  splash_screen_dom_window_addr: 0n,
  splash_screen_web_module_addr: 0n,
  splash_screen_web_module_impl_addr: 0n,
  init() {
    logger?.info("Initiate environment...");

    const window_addr = arw.addrof(window);
    logger?.debug(`window_addr: ${window_addr.hex()}`);

    this.wrapper_private_addr = arw.view(window_addr).getBigUint64(0x20, true);
    logger?.debug(`wrapper_private_addr: ${this.wrapper_private_addr.hex()}`);

    this.isolate_addr = arw.view(this.wrapper_private_addr).getBigUint64(0x8, true);
    logger?.debug(`isolate_addr: ${this.isolate_addr.hex()}`);

    this.splash_screen_dom_window_addr = arw.view(this.wrapper_private_addr).getBigUint64(0x10, true);
    logger?.debug(`splash_screen_dom_window_addr: ${this.splash_screen_dom_window_addr.hex()}`);

    const navigator_addr = arw.view(this.splash_screen_dom_window_addr).getBigUint64(0xc0, true);
    logger?.debug(`navigator_addr: ${navigator_addr.hex()}`);

    const maybe_freeze_callback_addr = arw.view(navigator_addr).getBigUint64(0xb0, true);
    logger?.debug(`maybe_freeze_callback_addr: ${maybe_freeze_callback_addr.hex()}`);

    this.browser_module_addr = arw.view(maybe_freeze_callback_addr).getBigUint64(0x30, true);
    logger?.debug(`browser_module_addr: ${this.browser_module_addr.hex()}`);

    this.main_web_module_addr = arw.view(this.browser_module_addr).getBigUint64(0x678, true);
    logger?.debug(`main_web_module_addr: ${this.main_web_module_addr.hex()}`);

    this.main_web_module_impl_addr = arw.view(this.main_web_module_addr).getBigUint64(0x18, true);
    logger?.debug(`main_web_module_impl_addr: ${this.main_web_module_impl_addr.hex()}`);

    this.main_dom_window_addr = arw.view(this.main_web_module_impl_addr).getBigUint64(0x230, true);
    logger?.debug(`main_dom_window_addr: ${this.main_dom_window_addr.hex()}`);

    this.splash_screen_addr = arw.view(this.browser_module_addr).getBigUint64(0x898, true);
    logger?.debug(`splash_screen_addr: ${this.splash_screen_addr.hex()}`);

    this.splash_screen_web_module_addr = arw.view(this.splash_screen_addr).getBigUint64(0x20, true);
    logger?.debug(`splash_screen_web_module_addr: ${this.splash_screen_web_module_addr.hex()}`);

    this.splash_screen_web_module_impl_addr = arw.view(this.splash_screen_web_module_addr).getBigUint64(0x18, true);
    logger?.debug(`splash_screen_web_module_impl_addr: ${this.splash_screen_web_module_impl_addr.hex()}`);

    this.disable_yt();
    this.disable_yt_cache();
    this.disable_psn_popup();
    //this.disable_hdcp(); // TODO

    logger?.info("Initialized environment !!");
  },
  disable_psn_popup() {
    logger?.info("Disabling PSN popup...");

    const sceMsgDialogTerminate = new NativeFunction(eboot_base + 0x215deb0n, "number");
    sceMsgDialogTerminate.invoke();

    // disable no internet connection
    const on_error_retry_timer_addr = this.browser_module_addr + 0x960n;
    logger?.debug(`on_error_retry_timer_addr: ${on_error_retry_timer_addr.hex()}`);

    const is_running_addr = on_error_retry_timer_addr + 0x60n;
    logger?.debug(`is_running_addr: ${is_running_addr.hex()}`);

    arw.view(is_running_addr).setUint8(0, 1);

    logger?.info("PSN popup disabled !!");
  },
  disable_yt() {
    logger?.info("Disabling YT...");

    const main_web_module_generation_addr = this.browser_module_addr + 0xb08n;
    arw.view(main_web_module_generation_addr).setInt32(0, -1, true);

    logger?.info("YT disabled !!");
  },
  disable_hdcp() {
    logger?.info("Disabling HDCP...");

    const sceEsvmTerminate = new NativeFunction(eboot_base + 0x215e350n);
    sceEsvmTerminate.invoke();

    const sceRemoteplayInitialize_addr = arw.view(eboot_base).getBigUint64(0x2a65f90, true);
    const libSceRemoteplay_addr = base_addr(sceRemoteplayInitialize_addr);
    logger?.debug(`libSceRemoteplay_addr: ${libSceRemoteplay_addr.hex()}`);

    const sceRemoteplaySetProhibition = new NativeFunction(libSceRemoteplay_addr + 0x15d0n, "number");

    if (sceRemoteplaySetProhibition.invoke(0)) {
      throw new Error("Unable to disable remote play prohibition !!");
    }
    
    logger?.info("HDCP disabled !!");
  },
  disable_yt_cache() {
    logger?.info("Disabling YT cache...");

    const splash_screen_dom_window_splash_screen_cache_callback_addr = arw.view(this.splash_screen_dom_window_addr).getBigUint64(0x150, true);
    logger?.debug(`splash_screen_dom_window_splash_screen_cache_callback_addr: ${splash_screen_dom_window_splash_screen_cache_callback_addr.hex()}`);

    const main_dom_window_splash_screen_cache_callback_addr = arw.view(this.main_dom_window_addr).getBigUint64(0x150, true);
    logger?.debug(`main_dom_window_splash_screen_cache_callback_addr: ${main_dom_window_splash_screen_cache_callback_addr.hex()}`);

    arw.view(this.main_dom_window_addr).setBigUint64(0x150, 0n, true);
    arw.view(this.splash_screen_dom_window_addr).setBigUint64(0x150, 0n, true);

    const splash_screen_dom_window_splash_screen_cache_addr = arw.view(splash_screen_dom_window_splash_screen_cache_callback_addr).getBigUint64(0x28, true);
    logger?.debug(`splash_screen_dom_window_splash_screen_cache_addr: ${splash_screen_dom_window_splash_screen_cache_addr.hex()}`);

    const main_dom_window_splash_screen_cache_addr = arw.view(main_dom_window_splash_screen_cache_callback_addr).getBigUint64(0x28, true);
    logger?.debug(`main_dom_window_splash_screen_cache_addr: ${main_dom_window_splash_screen_cache_addr.hex()}`);

    const last_page_hash = arw.view(main_dom_window_splash_screen_cache_addr).getUint32(0x50, true);
    logger?.debug(`last_page_hash: ${last_page_hash.bigint().hex()}`);

    //arw.view(splash_screen_cache_addr).setUint32(0x50, 0x67F84274, true); // override to original splash.html superfasthash

    logger?.info("YT cache disabled !!");
  },
};

logger?.info("===ENV===");

try {
  env.init();
} catch (e) {
  logger?.error(e.stack);
  mem.free_all();
}

logger?.info("===END===");
