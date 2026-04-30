import { RenderObject, resizeCanvasToDisplaySize } from "./webgl-utils";
import { InputManager, type InputState } from "./input-manager";

/**
 * Demand-driven WebGL2 render loop.
 *
 * The loop only issues draw calls when at least one managed RenderObject has
 * been mutated since the last frame, or when requestRedraw() is called manually.
 * Between frames where nothing has changed, requestAnimationFrame is still
 * scheduled (so the loop stays alive) but the render work is skipped entirely.
 *
 * Typical usage:
 *
 *   const loop = new RenderLoop(gl, canvas);
 *
 *   // Optional: called once before each frame's draw calls (clear, viewport, etc.)
 *   loop.onBeforeFrame = (gl, canvas) => {
 *     gl.viewport(0, 0, canvas.width, canvas.height);
 *     gl.clearColor(0, 0, 0, 1);
 *     gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
 *   };
 *
 *   // Optional: called after all draw calls in a frame
 *   loop.onAfterFrame = (gl, canvas) => { ... };
 *
 *   loop.add(myObject);   // auto-wires dirty notifications
 *   loop.start();
 *
 *   // Later, force a redraw without mutating any object:
 *   loop.requestRedraw();
 *
 *   // Pause / resume:
 *   loop.stop();
 *   loop.start();
 *
 *   // Clean up:
 *   loop.destroy();
 */
export class RenderLoop {

    // ── Private state ──────────────────────────────────────────────────────

    private gl:      WebGL2RenderingContext;
    private canvas:  HTMLCanvasElement;
    private objects: Set<RenderObject> = new Set();

    private rafHandle: number | null = null;
    private needsDraw: boolean = false;
    private running:   boolean = false;

    // ── Public hooks ───────────────────────────────────────────────────────

    /**
     * Called at the start of every frame that will draw, before any object's
     * draw() method runs. Use this for viewport setup, clearing, etc.
     *
     * @param gl      The WebGL2 context.
     * @param canvas  The canvas element (already resized if it changed).
     * @param time    DOMHighResTimeStamp from requestAnimationFrame.
     */
    onBeforeFrame: ((gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, time: number) => void) | null = null;

    /**
     * Called at the end of every frame that drew, after all objects have been
     * drawn. Use this for post-processing, overlays, stats, etc.
     *
     * @param gl      The WebGL2 context.
     * @param canvas  The canvas element.
     * @param time    DOMHighResTimeStamp from requestAnimationFrame.
     */
    onAfterFrame:  ((gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, time: number) => void) | null = null;

    /**
     * Called every frame (draw or idle) after input has been polled.
     * Use this to read input state and update uniforms, move objects, etc.
     * Returning true from this callback forces a redraw even if no RenderObject
     * was mutated — useful for continuous animations driven by held keys.
     *
     * @param input  Snapshot of the current input state for this frame.
     * @param time   DOMHighResTimeStamp from requestAnimationFrame.
     */
    onInput: ((input: InputState, time: number) => boolean | void) | null = null;

    private input: InputManager | null = null;

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
        this.gl     = gl;
        this.canvas = canvas;
    }

    /**
     * Attach an InputManager to this loop.
     * Any input event (key, mouse) will automatically call requestRedraw().
     * The polled InputState is passed to onInput each frame.
     */
    attachInput(input: InputManager): this {
        this.input = input;
        input.onActivity = () => this.requestRedraw();
        return this;
    }

    // ── Object management ──────────────────────────────────────────────────

    /**
     * Add a RenderObject to the loop. Its onDirty callback is wired up so
     * that any mutation (setUniform, setAttributeData, etc.) automatically
     * schedules a redraw.
     */
    add(obj: RenderObject): this {
        if (this.objects.has(obj)) return this;
        obj.onDirty = () => this.requestRedraw();
        this.objects.add(obj);
        // Treat a newly added object as dirty so it draws on the next frame.
        this.requestRedraw();
        return this;
    }

    /**
     * Remove a RenderObject from the loop and detach its dirty callback.
     * Does NOT destroy the object — call obj.destroy() yourself if needed.
     */
    remove(obj: RenderObject): this {
        if (!this.objects.has(obj)) return this;
        obj.onDirty = null;
        this.objects.delete(obj);
        this.requestRedraw();
        return this;
    }

    // ── Loop control ───────────────────────────────────────────────────────

    /** Start (or resume) the loop. Safe to call if already running. */
    start(): this {
        if (this.running) return this;
        this.running = true;
        this.scheduleFrame();
        return this;
    }

    /** Pause the loop. The current frame (if mid-flight) completes normally. */
    stop(): this {
        this.running = false;
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        return this;
    }

    /**
     * Manually request a redraw on the next frame.
     * Use this when something outside a RenderObject changes
     * (e.g. a camera move, a resize event, or a UI interaction).
     */
    requestRedraw(): this {
        this.needsDraw = true;
        return this;
    }

    /**
     * Stop the loop and detach all dirty callbacks.
     * Does NOT destroy any RenderObjects.
     */
    destroy(): void {
        this.stop();
        for (const obj of this.objects) {
            obj.onDirty = null;
        }
        this.objects.clear();
        this.input?.destroy();
        this.input = null;
    }

    // ── Internal ───────────────────────────────────────────────────────────

    private scheduleFrame(): void {
        this.rafHandle = requestAnimationFrame((time) => this.frame(time));
    }

    private frame(time: number): void {
        if (!this.running) return;

        // Poll input and call onInput every frame (even idle ones), so held
        // keys and continuous animations are never skipped.
        if (this.input && this.onInput) {
            const state = this.input.poll();
            const wantsRedraw = this.onInput(state, time);
            if (wantsRedraw) this.needsDraw = true;
        }

        // Always resize the canvas if needed, even on idle frames,
        // so we don't miss a window resize.
        const resized = resizeCanvasToDisplaySize(this.canvas);
        if (resized) {
            this.needsDraw = true;
        }

        if (this.needsDraw) {
            this.needsDraw = false;

            this.onBeforeFrame?.(this.gl, this.canvas, time);

            for (const obj of this.objects) {
                obj.draw();
            }

            this.onAfterFrame?.(this.gl, this.canvas, time);
        }

        this.scheduleFrame();
    }
}