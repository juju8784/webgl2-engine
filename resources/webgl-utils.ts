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
 */
export interface AttributeDescriptor {
    data:      Float32Array | Int32Array | Uint16Array | Uint8Array;
    size:      number;
    type?:     number;   // defaults to gl.FLOAT
    normalize?: boolean; // defaults to false
    stride?:   number;   // defaults to 0
    offset?:   number;   // defaults to 0
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
 *   obj.uploadBuffers();   // send data to GPU
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

    /** Whether buffers need re-uploading before the next draw. */
    private dirty: boolean = false;

    /**
     * Optional callback invoked whenever this object becomes dirty.
     * RenderLoop sets this automatically when you call loop.add(obj).
     * You can also set it manually if you manage your own loop.
     */
    onDirty: (() => void) | null = null;

    /** False when the program was passed in (shared) — destroy() won't delete it. */
    private ownsProgram: boolean;

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
     * Mark this object as needing a redraw and notify the render loop (if any).
     * Called automatically by all mutation methods; you can also call it manually
     * to force a redraw without changing any data (e.g. after a uniform-only update
     * where you want the loop to wake up).
     */
    markDirty(): this {
        this.dirty = true;
        this.onDirty?.();
        return this;
    }

    // ── Attribute API ──────────────────────────────────────────────────────

    /**
     * Register or update a vertex attribute.
     * Does NOT upload to the GPU — call uploadBuffers() for that.
     *
     * @param name  Must match the attribute name in the vertex shader (e.g. 'a_position').
     * @param desc  Attribute descriptor (data, size, optional type/normalize/stride/offset).
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

        return this.markDirty();
    }

    /** Remove an attribute (frees its GPU buffer). */
    removeAttribute(name: string): this {
        const entry = this.attributes.get(name);
        if (entry) {
            this.ctx.deleteBuffer(entry.buffer);
            this.attributes.delete(name);
            return this.markDirty();
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

    /** Byte offset into the first attribute buffer for drawArrays. */
    setDrawOffset(offset: number): this {
        this.drawOffset = offset;
        return this.markDirty();
    }

    // ── Buffer upload ──────────────────────────────────────────────────────

    /**
     * Upload all dirty attribute buffers to the GPU and re-bind the VAO.
     * Call this once after setting geometry, and again any time data changes.
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

            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, desc.data, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, desc.size, type, normalize, stride, offset);

            entry.dirty = false;
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Buffers are now clean; dirty was already set by setAttributeData,
        // so we clear it here rather than via markDirty.
        this.dirty = false;
        return this;
    }

    // ── Draw ───────────────────────────────────────────────────────────────

    /**
     * Execute a draw call using the object's stored state.
     *
     * @param uniformOverrides  Optional per-draw uniforms; merged on top of stored defaults.
     *                          Useful for per-frame values like u_time or u_modelMatrix.
     */
    draw(uniformOverrides?: Record<string, any>): void {
        if (this.dirty) {
            console.warn(
                "RenderObject.draw() called with un-uploaded buffer changes. " +
                "Call uploadBuffers() first."
            );
        }

        if (this.count === 0) {
            console.warn("RenderObject.draw() called with count = 0. Nothing drawn.");
            return;
        }

        const gl = this.ctx;

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);

        // Merge stored uniforms with any per-draw overrides
        const resolvedUniforms = uniformOverrides
            ? { ...this.uniforms, ...uniformOverrides }
            : this.uniforms;

        twgl.setUniforms(this.programInfo, resolvedUniforms);

        gl.drawArrays(this.primitiveType, this.drawOffset, this.count);

        gl.bindVertexArray(null);
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
        gl.deleteVertexArray(this.vao);
        // Only delete the program if this object compiled it — shared programs
        // must be deleted by whoever created them (e.g. twgl.createProgramInfo).
        if (this.ownsProgram) {
            gl.deleteProgram(this.program);
        }
    }
}