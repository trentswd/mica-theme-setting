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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
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
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAllWindows()));
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
