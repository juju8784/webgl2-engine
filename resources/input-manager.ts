/**
 * Snapshot of all input state for a single frame.
 * Handed to RenderLoop.onInput every frame.
 */
export interface InputState {
    // ── Keyboard ──────────────────────────────────────────────────────────

    /** Keys currently held down (by KeyboardEvent.code, e.g. "KeyW", "ArrowLeft"). */
    readonly keysHeld:    ReadonlySet<string>;

    /** Keys that were pressed for the first time this frame. */
    readonly keysPressed: ReadonlySet<string>;

    /** Keys that were released this frame. */
    readonly keysReleased: ReadonlySet<string>;

    // ── Mouse position ────────────────────────────────────────────────────

    /** Mouse position in canvas pixel coordinates. */
    readonly mouseX: number;
    readonly mouseY: number;

    /** How far the mouse moved since last frame (canvas pixels). */
    readonly mouseDeltaX: number;
    readonly mouseDeltaY: number;

    // ── Mouse buttons ─────────────────────────────────────────────────────

    /** Mouse buttons currently held (0=left, 1=middle, 2=right). */
    readonly buttonsHeld:     ReadonlySet<number>;

    /** Mouse buttons pressed for the first time this frame. */
    readonly buttonsPressed:  ReadonlySet<number>;

    /** Mouse buttons released this frame. */
    readonly buttonsReleased: ReadonlySet<number>;

    // ── Scroll ────────────────────────────────────────────────────────────

    /** Accumulated scroll delta since last frame (pixels, positive = down). */
    readonly scrollDeltaX: number;
    readonly scrollDeltaY: number;

    // ── Helpers ───────────────────────────────────────────────────────────

    /** True if a key is currently held. Shorthand for keysHeld.has(code). */
    isKeyHeld(code: string): boolean;

    /** True if a key was pressed this frame. */
    isKeyPressed(code: string): boolean;

    /** True if a key was released this frame. */
    isKeyReleased(code: string): boolean;

    /** True if a mouse button is currently held. */
    isButtonHeld(button: number): boolean;

    /** True if a mouse button was pressed this frame. */
    isButtonPressed(button: number): boolean;

    /** True if a mouse button was released this frame. */
    isButtonReleased(button: number): boolean;
}

// ─── InputManager ────────────────────────────────────────────────────────────

/**
 * Collects raw DOM input events and exposes a polled InputState snapshot
 * each frame. Attach to a RenderLoop via loop.attachInput(input).
 *
 * Typical usage:
 *
 *   const input = new InputManager(canvas);
 *   loop.attachInput(input);
 *
 *   loop.onInput = (state, time) => {
 *     if (state.isKeyHeld("ArrowRight")) {
 *       camera.x += 5;
 *       return true; // request redraw
 *     }
 *     if (state.scrollDeltaY !== 0) {
 *       camera.zoom -= state.scrollDeltaY * 0.01;
 *       return true;
 *     }
 *   };
 *
 * Canvas focus:
 *   For keyboard events to fire on the canvas, it must be focusable.
 *   Add tabindex="0" to your canvas element in HTML, or call
 *   InputManager.focusCanvas() after construction.
 */
export class InputManager {

    private canvas: HTMLCanvasElement;

    // ── Raw accumulated state (written by event listeners) ─────────────────

    private _keysHeld     = new Set<string>();
    private _keysPressed  = new Set<string>();
    private _keysReleased = new Set<string>();

    private _mouseX = 0;
    private _mouseY = 0;
    private _lastMouseX = 0;
    private _lastMouseY = 0;

    private _buttonsHeld     = new Set<number>();
    private _buttonsPressed  = new Set<number>();
    private _buttonsReleased = new Set<number>();

    private _scrollDeltaX = 0;
    private _scrollDeltaY = 0;

    /**
     * Cached result of canvas.getBoundingClientRect().
     * Calling getBoundingClientRect() on every mousemove forces a layout reflow,
     * which is expensive at high mouse speeds. We cache it and only refresh
     * when a resize or scroll invalidates the canvas's position.
     */
    private _cachedRect: DOMRect;

    /**
     * Called whenever any input event fires.
     * RenderLoop.attachInput() sets this to () => loop.requestRedraw()
     * so that any input automatically wakes the loop.
     */
    onActivity: (() => void) | null = null;

    // ── Event listener references (kept for cleanup) ───────────────────────

    private listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this._cachedRect = canvas.getBoundingClientRect();
        this.register();
    }

    /**
     * Make the canvas focusable and give it focus so keyboard events fire.
     * Call this if you didn't add tabindex="0" in HTML.
     */
    focusCanvas(): this {
        if (!this.canvas.hasAttribute("tabindex")) {
            this.canvas.setAttribute("tabindex", "0");
        }
        this.canvas.focus();
        return this;
    }

    // ── Poll ───────────────────────────────────────────────────────────────

    /**
     * Produce a frozen InputState snapshot for this frame, then clear all
     * per-frame sets (pressed, released, scroll deltas, mouse delta).
     * Called automatically by RenderLoop each frame.
     */
    poll(): InputState {
        const state: InputState = {
            keysHeld:     new Set(this._keysHeld),
            keysPressed:  new Set(this._keysPressed),
            keysReleased: new Set(this._keysReleased),

            mouseX: this._mouseX,
            mouseY: this._mouseY,
            mouseDeltaX: this._mouseX - this._lastMouseX,
            mouseDeltaY: this._mouseY - this._lastMouseY,

            buttonsHeld:     new Set(this._buttonsHeld),
            buttonsPressed:  new Set(this._buttonsPressed),
            buttonsReleased: new Set(this._buttonsReleased),

            scrollDeltaX: this._scrollDeltaX,
            scrollDeltaY: this._scrollDeltaY,

            isKeyHeld:       (code)   => state.keysHeld.has(code),
            isKeyPressed:    (code)   => state.keysPressed.has(code),
            isKeyReleased:   (code)   => state.keysReleased.has(code),
            isButtonHeld:    (button) => state.buttonsHeld.has(button),
            isButtonPressed: (button) => state.buttonsPressed.has(button),
            isButtonReleased:(button) => state.buttonsReleased.has(button),
        };

        // Clear per-frame state
        this._keysPressed.clear();
        this._keysReleased.clear();
        this._buttonsPressed.clear();
        this._buttonsReleased.clear();
        this._scrollDeltaX    = 0;
        this._scrollDeltaY    = 0;
        this._lastMouseX      = this._mouseX;
        this._lastMouseY      = this._mouseY;

        return state;
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    /** Remove all event listeners. Call this (or loop.destroy()) when done. */
    destroy(): void {
        for (const [target, type, fn] of this.listeners) {
            target.removeEventListener(type, fn);
        }
        this.listeners = [];
    }

    // ── Internal ───────────────────────────────────────────────────────────

    private on<K extends keyof HTMLElementEventMap>(
        target: EventTarget,
        type: K,
        fn: (e: HTMLElementEventMap[K]) => void
    ): void {
        // TypeScript-friendly wrapper that also stores refs for cleanup
        target.addEventListener(type, fn as EventListenerOrEventListenerObject);
        this.listeners.push([target, type, fn as EventListenerOrEventListenerObject]);
    }

    private register(): void {
        // ── Keyboard (on canvas so focus scope is natural) ─────────────────

        this.on(this.canvas, "keydown", (e) => {
            if (!this._keysHeld.has(e.code)) {
                this._keysPressed.add(e.code);
            }
            this._keysHeld.add(e.code);
            this.onActivity?.();
        });

        this.on(this.canvas, "keyup", (e) => {
            this._keysHeld.delete(e.code);
            this._keysReleased.add(e.code);
            this.onActivity?.();
        });

        // ── Mouse (on canvas) ──────────────────────────────────────────────

        this.on(this.canvas, "mousemove", (e) => {
            // Use the cached rect instead of calling getBoundingClientRect() every
            // event — the live call forces a layout reflow on each mouse move.
            const rect = this._cachedRect;
            const dpr  = window.devicePixelRatio;
            this._mouseX = (e.clientX - rect.left) * dpr;
            this._mouseY = (e.clientY - rect.top)  * dpr;
            this.onActivity?.();
        });

        this.on(this.canvas, "mousedown", (e) => {
            this._buttonsHeld.add(e.button);
            this._buttonsPressed.add(e.button);
            this.onActivity?.();
        });

        // mouseup on window so a button release outside the canvas isn't missed
        this.on(window, "mouseup", (e) => {
            this._buttonsHeld.delete(e.button);
            this._buttonsReleased.add(e.button);
            this.onActivity?.();
        });

        this.on(this.canvas, "wheel", (e) => {
            e.preventDefault();
            this._scrollDeltaX += e.deltaX;
            this._scrollDeltaY += e.deltaY;
            this.onActivity?.();
        });

        // ── Context menu (suppress right-click menu on canvas) ─────────────
        this.on(this.canvas, "contextmenu", (e) => {
            e.preventDefault();
        });

        // ── Rect cache invalidation ────────────────────────────────────────
        // Refresh the cached bounding rect when the canvas's position may have
        // changed. ResizeObserver covers canvas size changes; scroll covers
        // cases where the page scrolls and shifts the canvas's client position.

        const refreshRect = () => {
            this._cachedRect = this.canvas.getBoundingClientRect();
        };

        const ro = new ResizeObserver(refreshRect);
        ro.observe(this.canvas);
        // Store a synthetic listener entry so destroy() can disconnect it.
        this.listeners.push([
            { removeEventListener: () => ro.disconnect() } as unknown as EventTarget,
            "resize",
            refreshRect as EventListenerOrEventListenerObject,
        ]);

        // Re-cache on window scroll (canvas may have shifted in the viewport).
        this.on(window, "scroll", refreshRect as any);
    }
}