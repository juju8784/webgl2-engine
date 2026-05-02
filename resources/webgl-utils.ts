import * as twgl from "twgl.js";

// ─── Shader / Program Helpers ────────────────────────────────────────────────

/** Compiles a single shader stage. Throws a descriptive error on failure. */
export function compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string
): WebGLShader {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error:\n${log}`);
    }
    return shader;
}

/** Links a vertex + fragment shader into a program. Throws on failure. */
export function createProgram(
    gl: WebGL2RenderingContext,
    vertexShader: WebGLShader,
    fragmentShader: WebGLShader
): WebGLProgram {
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Program link error:\n${log}`);
    }
    return program;
}

/** Convenience wrapper: compile both stages and link in one call. */
export function createProgramFromSources(
    gl: WebGL2RenderingContext,
    shaderSources: { vertex: string; fragment: string }
): WebGLProgram {
    const vs = compileShader(gl, gl.VERTEX_SHADER, shaderSources.vertex);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, shaderSources.fragment);
    return createProgram(gl, vs, fs);
}

/** Resizes the canvas backing store to match its CSS display size (DPI-aware). */
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
    const displayWidth  = canvas.clientWidth  * window.devicePixelRatio;
    const displayHeight = canvas.clientHeight * window.devicePixelRatio;
    const needResize =
        canvas.width  !== displayWidth ||
        canvas.height !== displayHeight;

    if (needResize) {
        canvas.width  = displayWidth;
        canvas.height = displayHeight;
    }
    return needResize;
}

// ─── Attribute Descriptor ────────────────────────────────────────────────────

/**
 * Everything needed to describe one vertex attribute.
 *
 * @param data       Raw vertex data to upload (set via setAttributeData / uploadBuffers).
 * @param size       Components per vertex (e.g. 3 for vec3).
 * @param type       GL data type (default: gl.FLOAT).
 * @param normalize  Whether to normalise integer data (default: false).
 * @param stride     Byte stride between vertices (default: 0 = tightly packed).
 * @param offset     Byte offset of first element (default: 0).
 * @param dynamic    If true, uses gl.DYNAMIC_DRAW — better for data updated frequently at runtime.
 *                   If false (default), uses gl.STATIC_DRAW — better for geometry set once.
 */
export interface AttributeDescriptor {
    data:      Float32Array | Int32Array | Uint16Array | Uint8Array;
    size:      number;
    type?:     number;   // defaults to gl.FLOAT
    normalize?: boolean; // defaults to false
    stride?:   number;   // defaults to 0
    offset?:   number;   // defaults to 0
    dynamic?:  boolean;  // defaults to false (STATIC_DRAW)
}

// ─── RenderObject ────────────────────────────────────────────────────────────

/**
 * Self-contained WebGL2 render unit.
 *
 * Typical usage:
 *   const obj = new RenderObject(gl, vertSrc, fragSrc);
 *   obj.setAttributeData('a_position', { data: positions, size: 3 });
 *   obj.setAttributeData('a_normal',   { data: normals,   size: 3 });
 *   obj.setUniform('u_color', [1, 0, 0, 1]);
 *   obj.setCount(vertexCount);
 *   obj.uploadBuffers();   // send data to GPU (or let draw() handle it automatically)
 *   // ... in render loop:
 *   obj.draw();
 *   // or with per-frame override:
 *   obj.draw({ u_time: elapsed });
 */
export class RenderObject {

    // ── Core GL state ──────────────────────────────────────────────────────

    readonly ctx:         WebGL2RenderingContext;
    readonly programInfo: twgl.ProgramInfo;
    readonly program:     WebGLProgram;

    private vao: WebGLVertexArrayObject;

    // ── Attribute storage ──────────────────────────────────────────────────

    /** Per-attribute descriptor + its dedicated GPU buffer. */
    private attributes: Map<string, {
        desc:   AttributeDescriptor;
        buffer: WebGLBuffer;
        dirty:  boolean;
    }> = new Map();

    /**
     * Optional index buffer. When present, draw() issues drawElements with
     * `count` indices of `type` starting at `drawOffset` bytes.
     * When null, draw() issues drawArrays.
     */
    private indices: {
        data:    Uint8Array | Uint16Array | Uint32Array;
        type:    number;     // gl.UNSIGNED_BYTE / UNSIGNED_SHORT / UNSIGNED_INT
        buffer:  WebGLBuffer;
        dirty:   boolean;
        dynamic: boolean;
    } | null = null;

    // ── Uniform storage ────────────────────────────────────────────────────

    /** Stored defaults; merged with per-draw overrides at draw time. */
    private uniforms: Record<string, any> = {};

    // ── Draw settings ──────────────────────────────────────────────────────

    /** Number of vertices (or indices) to draw. Must be set before draw(). */
    private count: number = 0;

    /** GL primitive type (default: TRIANGLES). */
    private primitiveType: number;

    /** Byte offset into index buffer (default: 0). */
    private drawOffset: number = 0;

    /**
     * True when attribute buffers have changed and uploadBuffers() is needed.
     * Distinct from renderDirty so uniform-only changes never trigger the warning.
     */
    private buffersDirty: boolean = false;

    /**
     * True when anything has changed and a redraw is needed.
     * Set by both attribute and uniform changes.
     */
    private renderDirty: boolean = false;

    /**
     * Optional callback invoked whenever this object needs a redraw.
     * RenderLoop sets this automatically when you call loop.add(obj).
     */
    onDirty: (() => void) | null = null;

    /** False when the program was passed in (shared) — destroy() won't delete it. */
    private ownsProgram: boolean;

    /**
     * When false, draw() is a no-op and the object is skipped entirely.
     * Toggle this to show/hide an object without removing it from the loop.
     */
    visible: boolean = true;

    /**
     * Tracks the last program bound per GL context to avoid redundant
     * gl.useProgram calls when many objects share the same program.
     */
    private static _lastProgram: WeakMap<WebGL2RenderingContext, WebGLProgram | null>
        = new WeakMap();

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param ctx     WebGL2 context.
     * @param program Either a pre-built twgl.ProgramInfo (shared across objects)
     *                or an object with vertex/fragment shader source strings
     *                (a new program will be compiled for this object alone).
     *
     * Sharing a ProgramInfo across many objects with the same shaders is the
     * primary way to reduce RAM and GPU memory usage.
     */
    constructor(
        ctx: WebGL2RenderingContext,
        program: twgl.ProgramInfo | { vertex: string; fragment: string }
    ) {
        this.ctx = ctx;
        this.ownsProgram = !("program" in program);
        this.programInfo = this.ownsProgram
            ? twgl.createProgramInfo(ctx, [(program as {vertex:string;fragment:string}).vertex, (program as {vertex:string;fragment:string}).fragment])
            : (program as twgl.ProgramInfo);
        this.program       = this.programInfo.program;
        this.primitiveType = ctx.TRIANGLES;
        this.vao           = ctx.createVertexArray() as WebGLVertexArrayObject;
    }

    /**
     * Mark that attribute buffers need re-uploading AND that a redraw is needed.
     * Called automatically by setAttributeData / removeAttribute.
     */
    markBuffersDirty(): this {
        this.buffersDirty = true;
        this.renderDirty  = true;
        this.onDirty?.();
        return this;
    }

    /**
     * Mark that a redraw is needed without flagging buffers as dirty.
     * Called automatically by setUniform / setCount / setPrimitiveType etc.
     * Can also be called manually to force a redraw with no data change.
     */
    markDirty(): this {
        this.renderDirty = true;
        this.onDirty?.();
        return this;
    }

    // ── Attribute API ──────────────────────────────────────────────────────

    /**
     * Register or update a vertex attribute.
     * Does NOT upload to the GPU — call uploadBuffers() for that,
     * or simply let draw() handle it automatically.
     *
     * @param name  Must match the attribute name in the vertex shader (e.g. 'a_position').
     * @param desc  Attribute descriptor (data, size, optional type/normalize/stride/offset/dynamic).
     */
    setAttributeData(name: string, desc: AttributeDescriptor): this {
        const existing = this.attributes.get(name);

        if (existing) {
            existing.desc  = desc;
            existing.dirty = true;
        } else {
            const buffer = this.ctx.createBuffer();
            if (!buffer) throw new Error(`Failed to create GL buffer for attribute "${name}"`);
            this.attributes.set(name, { desc, buffer, dirty: true });
        }

        return this.markBuffersDirty();
    }

    /** Remove an attribute (frees its GPU buffer). */
    removeAttribute(name: string): this {
        const entry = this.attributes.get(name);
        if (entry) {
            this.ctx.deleteBuffer(entry.buffer);
            this.attributes.delete(name);
            return this.markBuffersDirty();
        }
        return this;
    }

    // ── Index API ──────────────────────────────────────────────────────────

    /**
     * Provide an index buffer so draw() uses drawElements instead of drawArrays.
     *
     * The GL component type is inferred from the typed-array constructor:
     *   Uint8Array  → UNSIGNED_BYTE
     *   Uint16Array → UNSIGNED_SHORT
     *   Uint32Array → UNSIGNED_INT  (always available in WebGL2)
     *
     * Automatically sets count = data.length so a typical GLB primitive doesn't
     * need a manual setCount(). Override afterwards if you want a partial draw.
     *
     * @param data    Index data. Must be one of the three unsigned integer typed arrays.
     * @param dynamic If true, uses gl.DYNAMIC_DRAW (frequent updates).
     *                Default false → gl.STATIC_DRAW (set once).
     */
    setIndices(
        data: Uint8Array | Uint16Array | Uint32Array,
        dynamic: boolean = false,
    ): this {
        const gl = this.ctx;

        let type: number;
        if      (data instanceof Uint8Array)  type = gl.UNSIGNED_BYTE;
        else if (data instanceof Uint16Array) type = gl.UNSIGNED_SHORT;
        else if (data instanceof Uint32Array) type = gl.UNSIGNED_INT;
        else throw new Error("RenderObject.setIndices: data must be Uint8Array, Uint16Array, or Uint32Array.");

        if (this.indices) {
            this.indices.data    = data;
            this.indices.type    = type;
            this.indices.dynamic = dynamic;
            this.indices.dirty   = true;
        } else {
            const buffer = gl.createBuffer();
            if (!buffer) throw new Error("RenderObject.setIndices: failed to create GL buffer.");
            this.indices = { data, type, buffer, dirty: true, dynamic };
        }

        // Sensible default — caller can override with setCount() afterwards
        // for partial draws (e.g. drawing one sub-range of a shared index buffer).
        this.count = data.length;

        return this.markBuffersDirty();
    }

    /**
     * Drop the index buffer (frees its GPU buffer) and return to drawArrays mode.
     * Does NOT reset count — call setCount() yourself if needed.
     */
    removeIndices(): this {
        if (this.indices) {
            this.ctx.deleteBuffer(this.indices.buffer);
            this.indices = null;
            return this.markBuffersDirty();
        }
        return this;
    }

    // ── Uniform API ────────────────────────────────────────────────────────

    /**
     * Set (or update) a stored uniform value.
     * Accepts any value that twgl.setUniforms understands
     * (number, number[], Float32Array, WebGLTexture, …).
     */
    setUniform(name: string, value: any): this {
        this.uniforms[name] = value;
        return this.markDirty();
    }

    /** Bulk-set multiple uniforms at once. */
    setUniforms(values: Record<string, any>): this {
        Object.assign(this.uniforms, values);
        return this.markDirty();
    }

    /** Remove a stored uniform (it will no longer be sent at draw time). */
    removeUniform(name: string): this {
        delete this.uniforms[name];
        return this.markDirty();
    }

    // ── Draw-setting API ───────────────────────────────────────────────────

    /** Total number of vertices (or indices) to pass to drawArrays. */
    setCount(count: number): this {
        this.count = count;
        return this.markDirty();
    }

    /** GL primitive type — e.g. gl.TRIANGLES, gl.LINES, gl.POINTS. */
    setPrimitiveType(type: number): this {
        this.primitiveType = type;
        return this.markDirty();
    }

    /**
     * Where to start drawing.
     *  - drawArrays mode (no indices): index of the first vertex (a count, not bytes).
     *  - drawElements mode (with indices): byte offset into the index buffer.
     */
    setDrawOffset(offset: number): this {
        this.drawOffset = offset;
        return this.markDirty();
    }

    // ── Buffer upload ──────────────────────────────────────────────────────

    /**
     * Upload all dirty attribute buffers to the GPU and re-bind the VAO.
     * Called automatically by draw() when buffers are dirty, but you can also
     * call it explicitly to pre-upload before the first frame.
     */
    uploadBuffers(): this {
        const gl = this.ctx;

        gl.bindVertexArray(this.vao);

        for (const [name, entry] of this.attributes) {
            if (!entry.dirty) continue;

            const loc = gl.getAttribLocation(this.program, name);
            if (loc === -1) {
                console.warn(`RenderObject: attribute "${name}" not found in shader — skipping.`);
                continue;
            }

            const { desc, buffer } = entry;
            const type      = desc.type      ?? gl.FLOAT;
            const normalize = desc.normalize ?? false;
            const stride    = desc.stride    ?? 0;
            const offset    = desc.offset    ?? 0;
            // Use DYNAMIC_DRAW for data updated frequently at runtime,
            // STATIC_DRAW (default) for geometry set once.
            const usage     = desc.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;

            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, desc.data, usage);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, desc.size, type, normalize, stride, offset);

            entry.dirty = false;
        }

        // Index buffer must be bound while the VAO is active — the
        // ELEMENT_ARRAY_BUFFER binding is stored as part of VAO state, so this
        // sticks to the VAO and is restored automatically on the next bind.
        if (this.indices && this.indices.dirty) {
            const usage = this.indices.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices.buffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.data, usage);
            this.indices.dirty = false;
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        // NOTE: Intentionally not unbinding ELEMENT_ARRAY_BUFFER — that binding
        // lives inside the VAO we just unbound, and unbinding it now would
        // affect the (now-active) default VAO instead, which is harmless to leave.

        this.buffersDirty = false;
        return this;
    }

    // ── Draw ───────────────────────────────────────────────────────────────

    /**
     * Execute a draw call using the object's stored state.
     * Automatically uploads any dirty buffers before drawing.
     *
     * @param uniformOverrides  Optional per-draw uniforms; merged on top of stored defaults.
     *                          Useful for per-frame values like u_time or u_modelMatrix.
     */
    draw(uniformOverrides?: Record<string, any>): void {
        // Skip invisible objects entirely — no GL calls at all.
        if (!this.visible) return;

        if (this.count === 0) {
            console.warn("RenderObject.draw() called with count = 0. Nothing drawn.");
            return;
        }

        // Auto-upload dirty buffers so callers don't need to call uploadBuffers() manually.
        if (this.buffersDirty) {
            this.uploadBuffers();
        }

        const gl = this.ctx;

        // Avoid redundant gl.useProgram calls — one of the most expensive WebGL
        // state changes — when many objects share the same program.
        const last = RenderObject._lastProgram.get(gl);
        if (last !== this.program) {
            gl.useProgram(this.program);
            RenderObject._lastProgram.set(gl, this.program);
        }

        gl.bindVertexArray(this.vao);

        // Merge stored uniforms with any per-draw overrides.
        const resolvedUniforms = uniformOverrides
            ? { ...this.uniforms, ...uniformOverrides }
            : this.uniforms;

        twgl.setUniforms(this.programInfo, resolvedUniforms);

        if (this.indices) {
            // drawOffset is interpreted as a BYTE offset into the index buffer here.
            gl.drawElements(this.primitiveType, this.count, this.indices.type, this.drawOffset);
        } else {
            // drawOffset is the index of the first vertex (a count, not bytes).
            gl.drawArrays(this.primitiveType, this.drawOffset, this.count);
        }

        // NOTE: Intentionally NOT calling gl.bindVertexArray(null) after each draw.
        // Unbinding is unnecessary overhead — the next draw() immediately rebinds
        // its own VAO, so the stale binding is never observed.
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    /**
     * Release all GPU resources held by this object.
     * The instance should not be used after calling this.
     */
    destroy(): void {
        const gl = this.ctx;
        for (const entry of this.attributes.values()) {
            gl.deleteBuffer(entry.buffer);
        }
        this.attributes.clear();
        if (this.indices) {
            gl.deleteBuffer(this.indices.buffer);
            this.indices = null;
        }
        gl.deleteVertexArray(this.vao);
        // Clear the cached program binding if it points to this object's program,
        // so the next object doesn't incorrectly skip a gl.useProgram call.
        if (RenderObject._lastProgram.get(gl) === this.program) {
            RenderObject._lastProgram.set(gl, null);
        }
        // Only delete the program if this object compiled it — shared programs
        // must be deleted by whoever created them (e.g. twgl.createProgramInfo).
        if (this.ownsProgram) {
            gl.deleteProgram(this.program);
        }
    }
}