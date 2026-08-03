"use strict";

const { Notice, Platform, Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  material: "mica",
  tintOpacity: 54,
  blur: 0
};

const MATERIALS = new Set(["mica", "tabbed", "acrylic"]);
const RESPONSIVE_MIN_ROOT_WIDTH = 320;
const RESPONSIVE_HYSTERESIS = 32;
const DEFAULT_SIDEBAR_WIDTH = 300;
const LIGHT_PREPAINT_COLOR = "#f6f1ee";
const DARK_PREPAINT_COLOR = "#24211f";
const TRANSPARENT_WINDOW_COLOR = "#00000000";
const OVERLAY_SCROLLBAR_MIN_THUMB = 24;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

class OverlayScrollbarController {
  constructor(domWindow) {
    this.domWindow = domWindow;
    this.document = domWindow.document;
    this.entries = new Map();
    this.scanTimers = [];
    this.onResize = () => this.updateAll();
    this.onPointerOver = event => this.discoverFromPath(event.composedPath?.() ?? []);
  }

  start() {
    this.domWindow.addEventListener("resize", this.onResize);
    this.document.addEventListener("pointerover", this.onPointerOver, true);
    this.scan();
    for (const delay of [0, 250, 1000, 2500]) {
      this.scanTimers.push(this.domWindow.setTimeout(() => this.scan(), delay));
    }
  }

  stop() {
    this.domWindow.removeEventListener("resize", this.onResize);
    this.document.removeEventListener("pointerover", this.onPointerOver, true);
    for (const timer of this.scanTimers) {
      this.domWindow.clearTimeout(timer);
    }
    this.scanTimers.length = 0;
    for (const source of Array.from(this.entries.keys())) {
      this.remove(source);
    }
  }

  isScrollable(element) {
    if (
      !element ||
      element.nodeType !== 1 ||
      element.ownerDocument !== this.document ||
      element.scrollHeight <= element.clientHeight + 1
    ) {
      return false;
    }
    const overflowY = this.domWindow.getComputedStyle(element).overflowY;
    return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  }

  discoverFromPath(path) {
    for (const element of path) {
      if (this.isScrollable(element)) {
        this.add(element);
        return;
      }
    }
  }

  scan() {
    const roots = this.document.querySelectorAll(".workspace, .modal-container, .prompt, .suggestion-container");
    for (const root of roots) {
      if (this.isScrollable(root)) {
        this.add(root);
      }
      for (const element of root.querySelectorAll("*")) {
        if (this.isScrollable(element)) {
          this.add(element);
        }
      }
    }
    this.updateAll();
  }

  add(source) {
    if (this.entries.has(source)) {
      return;
    }

    const track = this.document.createElement("div");
    track.className = "mica-overlay-scrollbar";
    track.setAttribute("aria-hidden", "true");
    const thumb = this.document.createElement("div");
    thumb.className = "mica-overlay-scrollbar-thumb";
    track.appendChild(thumb);
    this.document.body.appendChild(track);
    source.classList.add("mica-overlay-scrollbar-source");

    const entry = {
      source,
      track,
      thumb,
      dragging: false,
      startY: 0,
      startScrollTop: 0,
      scroll: () => this.update(source),
      pointerDown: event => this.onPointerDown(event, source),
      pointerMove: event => this.onPointerMove(event, source),
      pointerUp: event => this.onPointerUp(event, source)
    };
    source.addEventListener("scroll", entry.scroll, { passive: true });
    track.addEventListener("pointerdown", entry.pointerDown);
    track.addEventListener("pointermove", entry.pointerMove);
    track.addEventListener("pointerup", entry.pointerUp);
    track.addEventListener("pointercancel", entry.pointerUp);
    this.entries.set(source, entry);
    this.update(source);
  }

  remove(source) {
    const entry = this.entries.get(source);
    if (!entry) {
      return;
    }
    source.removeEventListener("scroll", entry.scroll);
    source.classList.remove("mica-overlay-scrollbar-source");
    entry.track.remove();
    this.entries.delete(source);
  }

  updateAll() {
    for (const source of Array.from(this.entries.keys())) {
      if (!source.isConnected) {
        this.remove(source);
      } else {
        this.update(source);
      }
    }
  }

  update(source) {
    const entry = this.entries.get(source);
    if (!entry) {
      return;
    }
    const rect = source.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    const bottom = Math.min(this.domWindow.innerHeight, rect.bottom);
    const height = Math.max(0, bottom - top);
    const maxScroll = source.scrollHeight - source.clientHeight;
    const visible = height > 0 && rect.width > 0 && maxScroll > 0;
    entry.track.classList.toggle("is-visible", visible);
    if (!visible) {
      return;
    }

    const thumbHeight = Math.max(
      OVERLAY_SCROLLBAR_MIN_THUMB,
      Math.min(height, height * source.clientHeight / source.scrollHeight)
    );
    const travel = Math.max(0, height - thumbHeight);
    const thumbTop = maxScroll > 0 ? travel * source.scrollTop / maxScroll : 0;
    entry.track.style.top = `${top}px`;
    entry.track.style.right = `${Math.max(0, this.domWindow.innerWidth - rect.right)}px`;
    entry.track.style.height = `${height}px`;
    entry.thumb.style.height = `${thumbHeight}px`;
    entry.thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  onPointerDown(event, source) {
    const entry = this.entries.get(source);
    if (!entry || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.target !== entry.thumb) {
      const sourceRect = source.getBoundingClientRect();
      const direction = event.clientY < entry.thumb.getBoundingClientRect().top ? -1 : 1;
      source.scrollBy({ top: direction * sourceRect.height * 0.85, behavior: "auto" });
      return;
    }
    entry.dragging = true;
    entry.startY = event.clientY;
    entry.startScrollTop = source.scrollTop;
    entry.track.classList.add("is-dragging");
    entry.track.setPointerCapture(event.pointerId);
  }

  onPointerMove(event, source) {
    const entry = this.entries.get(source);
    if (!entry?.dragging) {
      return;
    }
    event.preventDefault();
    const trackHeight = entry.track.getBoundingClientRect().height;
    const thumbHeight = entry.thumb.getBoundingClientRect().height;
    const travel = Math.max(1, trackHeight - thumbHeight);
    const maxScroll = Math.max(0, source.scrollHeight - source.clientHeight);
    source.scrollTop = entry.startScrollTop + (event.clientY - entry.startY) * maxScroll / travel;
  }

  onPointerUp(event, source) {
    const entry = this.entries.get(source);
    if (!entry?.dragging) {
      return;
    }
    entry.dragging = false;
    entry.track.classList.remove("is-dragging");
    if (entry.track.hasPointerCapture(event.pointerId)) {
      entry.track.releasePointerCapture(event.pointerId);
    }
  }
}

class MicaThemeSettingPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.material = MATERIALS.has(this.settings.material) ? this.settings.material : DEFAULT_SETTINGS.material;
    this.settings.tintOpacity = clampNumber(this.settings.tintOpacity, 0, 100, DEFAULT_SETTINGS.tintOpacity);
    this.settings.blur = clampNumber(this.settings.blur, 0, 40, DEFAULT_SETTINGS.blur);
    this.decoratedWindows = new Set();
    this.nativeWindowMaterials = new Map();
    this.nativeWindowHooks = new Map();
    this.overlayScrollbarControllers = new Map();
    this.autoCollapsedSidebars = { left: false, right: false };
    this.lastSidebarWidths = { left: DEFAULT_SIDEBAR_WIDTH, right: DEFAULT_SIDEBAR_WIDTH };
    this.remote = this.getElectronRemote();

    this.addSettingTab(new MicaThemeSettingTab(this.app, this));
    this.addCommand({
      id: "reapply-material",
      name: "Reapply material to all windows",
      callback: () => {
        this.nativeWindowMaterials.clear();
        this.refreshAllWindows();
        this.refreshNativeWindowDecorations();
        new Notice("Obsidian Mica material reapplied");
      }
    });

    if (!Platform.isWin) {
      return;
    }

    this.registerNativeWindowCreationHook();

    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, domWindow) => {
        /* Establish the native backdrop before the DOM becomes transparent. */
        this.applyNativeMaterial();
        this.decorateDomWindow(domWindow);
        window.setTimeout(() => this.refreshAllWindows(), 0);
        window.setTimeout(() => this.refreshAllWindows(), 250);
      })
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, domWindow) => {
        this.undecorateDomWindow(domWindow);
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshAllWindows();
        this.scanOverlayScrollbars();
      })
    );
    this.registerInterval(window.setInterval(() => this.refreshAllWindows(), 750));
    this.app.workspace.onLayoutReady(() => {
      this.registerDomEvent(this.getWorkspaceWindow(), "resize", () => this.updateResponsiveSidebars());
      this.refreshAllWindows();
    });
  }

  onunload() {
    this.restoreResponsiveSidebars();
    for (const domWindow of this.decoratedWindows) {
      this.undecorateDomWindow(domWindow);
    }
    this.clearNativeMaterial();
    this.removeNativeWindowHooks();
    for (const controller of this.overlayScrollbarControllers.values()) {
      controller.stop();
    }
    this.overlayScrollbarControllers.clear();
  }

  getElectronRemote() {
    try {
      const loader = typeof require === "function" ? require : window.require;
      return loader ? loader("@electron/remote") : null;
    } catch (error) {
      console.error("Mica Theme Setting: Electron remote is unavailable", error);
      return null;
    }
  }

  collectDomWindows() {
    const windows = new Set([window]);
    if (typeof activeWindow !== "undefined" && activeWindow) {
      windows.add(activeWindow);
    }
    this.app.workspace.iterateAllLeaves(leaf => {
      const domWindow = leaf.containerEl?.ownerDocument?.defaultView;
      if (domWindow) {
        windows.add(domWindow);
      }
    });
    return windows;
  }

  registerNativeWindowCreationHook() {
    const electronApp = this.remote?.app;
    if (!electronApp?.on) {
      return;
    }
    this.nativeWindowCreatedHandler = (_event, nativeWindow) => {
      this.prepareNativeWindow(nativeWindow);
    };
    electronApp.on("browser-window-created", this.nativeWindowCreatedHandler);
    this.register(() => {
      electronApp.removeListener?.("browser-window-created", this.nativeWindowCreatedHandler);
    });
  }

  getPrepaintColor() {
    try {
      const body = document.body;
      const computed = body ? window.getComputedStyle(body) : null;
      const themeColor = computed?.getPropertyValue("--obsidian-mica-glass-fallback")?.trim();
      if (themeColor && !themeColor.startsWith("var(")) {
        return themeColor;
      }
      return body?.classList.contains("theme-dark") ? DARK_PREPAINT_COLOR : LIGHT_PREPAINT_COLOR;
    } catch (_error) {
      return LIGHT_PREPAINT_COLOR;
    }
  }

  getNativeDecorationScript() {
    const materialClass = `obsidian-mica-material-${this.settings.material}`;
    const tintOpacity = String(this.settings.tintOpacity / 100);
    const blur = `${this.settings.blur}px`;
    return `(() => {
      const body = document.body;
      if (!body) return false;
      body.classList.add("is-translucent", "mica-theme-setting");
      body.classList.remove(
        "obsidian-mica-material-mica",
        "obsidian-mica-material-tabbed",
        "obsidian-mica-material-acrylic"
      );
      body.classList.add(${JSON.stringify(materialClass)});
      body.style.setProperty("--workspace-background-translucent", "transparent");
      body.style.setProperty("--titlebar-background", "transparent");
      body.style.setProperty("--titlebar-background-focused", "transparent");
      body.style.setProperty("--obsidian-mica-glass-opacity", ${JSON.stringify(tintOpacity)});
      body.style.setProperty("--obsidian-mica-glass-blur", ${JSON.stringify(blur)});
      void body.offsetWidth;
      return true;
    })()`;
  }

  getNativeUndecorationScript() {
    return `(() => {
      const body = document.body;
      if (!body) return false;
      body.classList.remove(
        "mica-theme-setting",
        "is-translucent",
        "obsidian-mica-material-mica",
        "obsidian-mica-material-tabbed",
        "obsidian-mica-material-acrylic"
      );
      body.style.removeProperty("--workspace-background-translucent");
      body.style.removeProperty("--titlebar-background");
      body.style.removeProperty("--titlebar-background-focused");
      body.style.removeProperty("--obsidian-mica-glass-opacity");
      body.style.removeProperty("--obsidian-mica-glass-blur");
      return true;
    })()`;
  }

  setNativeWindowPrepaint(nativeWindow) {
    try {
      nativeWindow.setBackgroundColor?.(this.getPrepaintColor());
    } catch (error) {
      console.error("Mica Theme Setting: failed to set window prepaint color", error);
    }
  }

  async decorateNativeWindow(nativeWindow, revealMaterial) {
    const webContents = nativeWindow?.webContents;
    if (!webContents || webContents.isDestroyed?.()) {
      return;
    }
    try {
      const decorated = await webContents.executeJavaScript(this.getNativeDecorationScript(), true);
      if (decorated && revealMaterial && !nativeWindow.isDestroyed()) {
        nativeWindow.setBackgroundColor?.(TRANSPARENT_WINDOW_COLOR);
      }
    } catch (error) {
      if (!webContents.isDestroyed?.()) {
        console.error("Mica Theme Setting: failed to decorate window contents", error);
      }
    }
  }

  prepareNativeWindow(nativeWindow) {
    if (!nativeWindow || nativeWindow.isDestroyed?.()) {
      return;
    }
    const id = nativeWindow.id;
    this.applyNativeMaterialToWindow(nativeWindow);
    if (this.nativeWindowHooks.has(id)) {
      return;
    }
    this.setNativeWindowPrepaint(nativeWindow);

    const webContents = nativeWindow.webContents;
    if (!webContents || webContents.isDestroyed?.()) {
      return;
    }
    const onDidStartNavigation = (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame !== false) {
        this.setNativeWindowPrepaint(nativeWindow);
        this.applyNativeMaterialToWindow(nativeWindow);
      }
    };
    const onDomReady = () => {
      void this.decorateNativeWindow(nativeWindow, false);
    };
    const onDidFinishLoad = () => {
      if (this.isManagedNativeWindow(nativeWindow)) {
        void this.decorateNativeWindow(nativeWindow, true);
      } else {
        this.removeNativeWindowHook(id);
        this.nativeWindowMaterials.delete(id);
        nativeWindow.setBackgroundMaterial?.("none");
      }
    };
    const cleanup = () => this.removeNativeWindowHook(id);

    webContents.on("did-start-navigation", onDidStartNavigation);
    webContents.on("dom-ready", onDomReady);
    webContents.on("did-finish-load", onDidFinishLoad);
    nativeWindow.once("closed", cleanup);
    this.nativeWindowHooks.set(id, {
      nativeWindow,
      webContents,
      onDidStartNavigation,
      onDomReady,
      onDidFinishLoad,
      cleanup
    });

    if (!webContents.isLoadingMainFrame?.()) {
      void this.decorateNativeWindow(nativeWindow, true);
    }
  }

  removeNativeWindowHook(id) {
    const hook = this.nativeWindowHooks.get(id);
    if (!hook) {
      return;
    }
    hook.webContents.removeListener?.("did-start-navigation", hook.onDidStartNavigation);
    hook.webContents.removeListener?.("dom-ready", hook.onDomReady);
    hook.webContents.removeListener?.("did-finish-load", hook.onDidFinishLoad);
    hook.nativeWindow.removeListener?.("closed", hook.cleanup);
    this.nativeWindowHooks.delete(id);
    this.nativeWindowMaterials.delete(id);
  }

  removeNativeWindowHooks() {
    for (const id of Array.from(this.nativeWindowHooks.keys())) {
      this.removeNativeWindowHook(id);
    }
  }

  decorateDomWindow(domWindow) {
    const body = domWindow?.document?.body;
    if (!body) {
      return;
    }
    body.classList.add("is-translucent", "mica-theme-setting");
    body.classList.remove("obsidian-mica-material-mica", "obsidian-mica-material-tabbed", "obsidian-mica-material-acrylic");
    body.classList.add(`obsidian-mica-material-${this.settings.material}`);
    body.style.setProperty("--workspace-background-translucent", "transparent");
    body.style.setProperty("--titlebar-background", "transparent");
    body.style.setProperty("--titlebar-background-focused", "transparent");
    body.style.setProperty("--obsidian-mica-glass-opacity", String(this.settings.tintOpacity / 100));
    body.style.setProperty("--obsidian-mica-glass-blur", `${this.settings.blur}px`);
    if (!this.overlayScrollbarControllers.has(domWindow)) {
      const controller = new OverlayScrollbarController(domWindow);
      this.overlayScrollbarControllers.set(domWindow, controller);
      controller.start();
    }
    this.decoratedWindows.add(domWindow);
  }

  undecorateDomWindow(domWindow) {
    const body = domWindow?.document?.body;
    if (body) {
      body.classList.remove(
        "mica-theme-setting",
        "is-translucent",
        "obsidian-mica-material-mica",
        "obsidian-mica-material-tabbed",
        "obsidian-mica-material-acrylic"
      );
      body.style.removeProperty("--workspace-background-translucent");
      body.style.removeProperty("--titlebar-background");
      body.style.removeProperty("--titlebar-background-focused");
      body.style.removeProperty("--obsidian-mica-glass-opacity");
      body.style.removeProperty("--obsidian-mica-glass-blur");
    }
    this.overlayScrollbarControllers.get(domWindow)?.stop();
    this.overlayScrollbarControllers.delete(domWindow);
    this.decoratedWindows.delete(domWindow);
  }

  getNativeWindows() {
    try {
      const BrowserWindow = this.remote?.BrowserWindow;
      if (!BrowserWindow) {
        return [];
      }
      return BrowserWindow.getAllWindows().filter(nativeWindow => this.isManagedNativeWindow(nativeWindow));
    } catch (error) {
      console.error("Mica Theme Setting: failed to enumerate native windows", error);
      return [];
    }
  }

  isManagedNativeWindow(nativeWindow) {
    if (!nativeWindow || nativeWindow.isDestroyed?.()) {
      return false;
    }
    const url = nativeWindow.webContents?.getURL?.() ?? "";
    const title = nativeWindow.getTitle?.() ?? "";
    return url.startsWith("app://obsidian.md") || url === "about:blank" || title.includes("Obsidian");
  }

  applyNativeMaterial() {
    for (const nativeWindow of this.getNativeWindows()) {
      this.prepareNativeWindow(nativeWindow);
    }
  }

  refreshNativeWindowDecorations() {
    for (const nativeWindow of this.getNativeWindows()) {
      if (!nativeWindow.webContents?.isLoadingMainFrame?.()) {
        void this.decorateNativeWindow(nativeWindow, true);
      }
    }
  }

  applyNativeMaterialToWindow(nativeWindow) {
    try {
      const id = nativeWindow.id;
      if (this.nativeWindowMaterials.get(id) === this.settings.material) {
        return;
      }
      nativeWindow.setBackgroundMaterial?.(this.settings.material);
      this.nativeWindowMaterials.set(id, this.settings.material);
    } catch (error) {
      console.error("Mica Theme Setting: failed to apply native material", error);
    }
  }

  clearNativeMaterial() {
    for (const nativeWindow of this.getNativeWindows()) {
      try {
        void nativeWindow.webContents?.executeJavaScript?.(this.getNativeUndecorationScript(), true);
        nativeWindow.setBackgroundColor?.(this.getPrepaintColor());
        nativeWindow.setBackgroundMaterial?.("none");
      } catch (error) {
        console.error("Mica Theme Setting: failed to clear native material", error);
      }
    }
    this.nativeWindowMaterials.clear();
  }

  refreshAllWindows() {
    if (!Platform.isWin) {
      return;
    }
    for (const domWindow of this.collectDomWindows()) {
      this.decorateDomWindow(domWindow);
    }
    this.applyNativeMaterial();
    this.updateResponsiveSidebars();
    for (const controller of this.overlayScrollbarControllers.values()) {
      if (controller.entries.size === 0) {
        controller.scan();
      } else {
        controller.updateAll();
      }
    }
  }

  scanOverlayScrollbars() {
    window.setTimeout(() => {
      for (const controller of this.overlayScrollbarControllers.values()) {
        controller.scan();
      }
    }, 0);
  }

  getWorkspaceWindow() {
    return this.app.workspace.rootSplit?.containerEl?.ownerDocument?.defaultView ?? window;
  }

  getRibbonWidth(domWindow) {
    const ribbon = domWindow.document.querySelector(".workspace-ribbon.mod-left");
    return ribbon instanceof HTMLElement ? ribbon.getBoundingClientRect().width : 0;
  }

  rememberSidebarWidth(side, split) {
    if (split.collapsed) {
      return this.lastSidebarWidths[side];
    }
    const elementWidth = split.containerEl?.getBoundingClientRect?.().width ?? 0;
    const splitSize = Number(split.size);
    const width = elementWidth > 0 ? elementWidth : Number.isFinite(splitSize) && splitSize > 0 ? splitSize : 0;
    if (width > 0) {
      this.lastSidebarWidths[side] = width;
    }
    return this.lastSidebarWidths[side];
  }

  collapseSidebar(side, split) {
    if (!split.collapsed) {
      this.autoCollapsedSidebars[side] = true;
      split.collapse();
    }
  }

  restoreSidebar(side, split) {
    if (!this.autoCollapsedSidebars[side]) {
      return;
    }
    this.autoCollapsedSidebars[side] = false;
    if (split.collapsed) {
      split.expand();
    }
  }

  updateResponsiveSidebars() {
    const workspaceWindow = this.getWorkspaceWindow();
    if (!Platform.isWin || workspaceWindow.innerWidth <= 0) {
      return;
    }
    const { leftSplit, rightSplit } = this.app.workspace;
    if (!leftSplit || !rightSplit) {
      return;
    }

    const leftWidth = this.rememberSidebarWidth("left", leftSplit);
    const rightWidth = this.rememberSidebarWidth("right", rightSplit);
    const leftThreshold = this.getRibbonWidth(workspaceWindow) + leftWidth + RESPONSIVE_MIN_ROOT_WIDTH;
    const rightThreshold = leftThreshold + rightWidth;
    const windowWidth = workspaceWindow.innerWidth;

    if (windowWidth < leftThreshold) {
      this.collapseSidebar("right", rightSplit);
      this.collapseSidebar("left", leftSplit);
      return;
    }

    if (windowWidth >= leftThreshold + RESPONSIVE_HYSTERESIS) {
      this.restoreSidebar("left", leftSplit);
    }

    if (windowWidth < rightThreshold) {
      this.collapseSidebar("right", rightSplit);
    } else if (windowWidth >= rightThreshold + RESPONSIVE_HYSTERESIS) {
      this.restoreSidebar("right", rightSplit);
    }
  }

  restoreResponsiveSidebars() {
    const { leftSplit, rightSplit } = this.app.workspace;
    this.restoreSidebar("left", leftSplit);
    this.restoreSidebar("right", rightSplit);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async setMaterial(material) {
    if (!MATERIALS.has(material)) {
      return;
    }
    this.settings.material = material;
    await this.saveSettings();
    this.nativeWindowMaterials.clear();
    this.refreshAllWindows();
    this.refreshNativeWindowDecorations();
  }

  async setTintOpacity(tintOpacity) {
    this.settings.tintOpacity = clampNumber(tintOpacity, 0, 100, DEFAULT_SETTINGS.tintOpacity);
    await this.saveSettings();
    this.refreshAllWindows();
    this.refreshNativeWindowDecorations();
  }

  async setBlur(blur) {
    this.settings.blur = clampNumber(blur, 0, 40, DEFAULT_SETTINGS.blur);
    await this.saveSettings();
    this.refreshAllWindows();
    this.refreshNativeWindowDecorations();
  }
}

class MicaThemeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Mica Theme Setting" });

    new Setting(containerEl)
      .setName("Windows material")
      .setDesc("Applied to the main window and every later settings or pop-out window.")
      .addDropdown(dropdown =>
        dropdown
          .addOption("mica", "Mica")
          .addOption("tabbed", "Mica Alt")
          .addOption("acrylic", "Acrylic")
          .setValue(this.plugin.settings.material)
          .onChange(async value => {
            await this.plugin.setMaterial(value);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Glass tint opacity")
      .setDesc("Acrylic only. Opacity of the theme color layered above the native material.")
      .addSlider(slider =>
        slider
          .setLimits(0, 100, 1)
          .setValue(this.plugin.settings.tintOpacity)
          .setDynamicTooltip()
          .setDisabled(this.plugin.settings.material !== "acrylic")
          .onChange(value => this.plugin.setTintOpacity(value))
      );

    new Setting(containerEl)
      .setName("Surface blur")
      .setDesc("Acrylic only. Additional CSS backdrop blur in pixels.")
      .addSlider(slider =>
        slider
          .setLimits(0, 40, 1)
          .setValue(this.plugin.settings.blur)
          .setDynamicTooltip()
          .setDisabled(this.plugin.settings.material !== "acrylic")
          .onChange(value => this.plugin.setBlur(value))
      );
  }
}

module.exports = MicaThemeSettingPlugin;
