/**
 * Minimal custom GLB (glTF 2.0 binary) parser.
 *
 * Extracts mesh primitives in a form ready to feed straight into
 * RenderObject.setAttributeData / setIndices:
 *
 *   const model = await parseGLB("models/sphere.glb");
 *   const prim  = model.meshes[0].primitives[0];
 *
 *   obj.setAttributeData("a_position", { data: prim.positions, size: 3 });
 *   if (prim.normals) obj.setAttributeData("a_normal", { data: prim.normals, size: 3 });
 *   if (prim.uvs)     obj.setAttributeData("a_uv",     { data: prim.uvs,     size: 2 });
 *
 * Supports:
 *   - GLB version 2 with one BIN chunk (the common case).
 *   - POSITION / NORMAL / TEXCOORD_0 attributes.
 *   - Indexed and non-indexed primitives (UNSIGNED_SHORT / UNSIGNED_INT).
 *   - Interleaved bufferViews (de-interleaves into tight arrays).
 *
 * Out of scope (intentionally — keep it small for now):
 *   - External .bin/.gltf files (we only handle self-contained .glb).
 *   - Tangents, colors, joints/weights, multiple UV sets.
 *   - Skins, animations, materials, textures, scene graph traversal.
 *   - Sparse accessors and morph targets.
 */

// ─── glTF / GLB constants ────────────────────────────────────────────────────

const GLB_MAGIC  = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN  = 0x004e4942; // 'BIN\0'

/** glTF accessor.componentType → typed-array constructor. */
const COMPONENT_TYPE_TO_ARRAY = {
    5120: Int8Array,    // BYTE
    5121: Uint8Array,   // UNSIGNED_BYTE
    5122: Int16Array,   // SHORT
    5123: Uint16Array,  // UNSIGNED_SHORT
    5125: Uint32Array,  // UNSIGNED_INT
    5126: Float32Array, // FLOAT
} as const;

/** Bytes-per-component for each glTF componentType. */
const COMPONENT_TYPE_TO_BYTES = {
    5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
} as const;

/** glTF accessor.type → number of components per element. */
const TYPE_TO_COMPONENTS = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
} as const;

/** Union of every typed-array shape readAccessor() can produce. */
type TypedArray =
    | Int8Array  | Uint8Array
    | Int16Array | Uint16Array
    | Uint32Array
    | Float32Array;

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * One drawable chunk of a mesh — already de-interleaved into tight typed arrays.
 *
 * `vertexCount` is the number of POSITION elements (positions.length / 3).
 * If `indices` is present, draw with drawElements(count = indices.length);
 * otherwise draw with drawArrays(count = vertexCount).
 */
export interface GLBPrimitive {
    positions:    Float32Array;
    normals?:     Float32Array;
    uvs?:         Float32Array;
    indices?:     Uint16Array | Uint32Array;
    vertexCount:  number;
    indexCount?:  number;
    /** GL primitive mode (default 4 = TRIANGLES, per glTF spec). */
    mode:         number;
}

export interface GLBMesh {
    name?:       string;
    primitives:  GLBPrimitive[];
}

export interface GLBModel {
    meshes: GLBMesh[];
    /** Raw glTF JSON, exposed for callers that need extras (materials, nodes, …). */
    json:   any;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch a .glb file and parse it. Convenience wrapper around parseGLBBuffer().
 *
 * @param url  URL or relative path to the .glb file.
 */
export async function parseGLB(url: string): Promise<GLBModel> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`parseGLB: failed to fetch "${url}" (HTTP ${res.status})`);
    }
    const buffer = await res.arrayBuffer();
    return parseGLBBuffer(buffer);
}

/**
 * Parse an already-loaded .glb byte buffer.
 * Use this when bytes are obtained outside of fetch (drag-drop, FileReader, etc.).
 */
export function parseGLBBuffer(buffer: ArrayBuffer): GLBModel {
    const { json, bin } = readGLBChunks(buffer);
    if (!bin) {
        throw new Error("parseGLB: file has no BIN chunk (external .bin not supported).");
    }

    const meshes: GLBMesh[] = [];

    for (const meshDef of json.meshes ?? []) {
        const primitives: GLBPrimitive[] = [];

        for (const primDef of meshDef.primitives ?? []) {
            primitives.push(readPrimitive(json, bin, primDef));
        }

        meshes.push({ name: meshDef.name, primitives });
    }

    return { meshes, json };
}

// ─── Internal: chunk splitter ────────────────────────────────────────────────

/**
 * Split a GLB into its JSON and BIN chunks. Validates the 12-byte header
 * and walks chunks in order. Returns `bin = null` if no BIN chunk is present.
 */
function readGLBChunks(buffer: ArrayBuffer): { json: any; bin: ArrayBuffer | null } {
    if (buffer.byteLength < 12) {
        throw new Error("parseGLB: buffer too small to contain a GLB header.");
    }

    const dv = new DataView(buffer);

    const magic   = dv.getUint32(0, true);
    const version = dv.getUint32(4, true);
    const total   = dv.getUint32(8, true);

    if (magic !== GLB_MAGIC) {
        throw new Error(`parseGLB: bad magic 0x${magic.toString(16)} (expected 'glTF').`);
    }
    if (version !== 2) {
        throw new Error(`parseGLB: unsupported GLB version ${version} (only v2 is supported).`);
    }
    if (total > buffer.byteLength) {
        throw new Error(`parseGLB: header length ${total} exceeds buffer size ${buffer.byteLength}.`);
    }

    let cursor = 12;
    let json: any = null;
    let bin: ArrayBuffer | null = null;

    while (cursor < total) {
        const chunkLength = dv.getUint32(cursor, true);
        const chunkType   = dv.getUint32(cursor + 4, true);
        cursor += 8;

        if (chunkType === CHUNK_JSON) {
            const bytes = new Uint8Array(buffer, cursor, chunkLength);
            const text  = new TextDecoder("utf-8").decode(bytes);
            json = JSON.parse(text);
        } else if (chunkType === CHUNK_BIN) {
            // slice() copies — gives us an isolated, 0-aligned buffer for typed-array views.
            bin = buffer.slice(cursor, cursor + chunkLength);
        }
        // Unknown chunk types are skipped per the GLB spec.

        cursor += chunkLength;
    }

    if (!json) {
        throw new Error("parseGLB: no JSON chunk found.");
    }

    return { json, bin };
}

// ─── Internal: primitive extraction ──────────────────────────────────────────

function readPrimitive(json: any, bin: ArrayBuffer, primDef: any): GLBPrimitive {
    const attrs = primDef.attributes ?? {};

    if (attrs.POSITION === undefined) {
        throw new Error("parseGLB: primitive has no POSITION attribute.");
    }

    const positions = readAccessor(json, bin, attrs.POSITION) as Float32Array;

    const normals = attrs.NORMAL !== undefined
        ? readAccessor(json, bin, attrs.NORMAL) as Float32Array
        : undefined;

    const uvs = attrs.TEXCOORD_0 !== undefined
        ? readAccessor(json, bin, attrs.TEXCOORD_0) as Float32Array
        : undefined;

    let indices: Uint16Array | Uint32Array | undefined;
    if (primDef.indices !== undefined) {
        const raw = readAccessor(json, bin, primDef.indices);
        if (raw instanceof Uint16Array || raw instanceof Uint32Array) {
            indices = raw;
        } else {
            // Other index types (e.g. UNSIGNED_BYTE) — promote to Uint16Array.
            // Typed arrays satisfy ArrayLike<number>, so this copies element-wise.
            indices = new Uint16Array(raw);
        }
    }

    // Build conditionally so optional fields stay omitted when absent
    // (required by exactOptionalPropertyTypes in tsconfig).
    const prim: GLBPrimitive = {
        positions,
        vertexCount: positions.length / 3,
        mode:        primDef.mode ?? 4, // glTF default = TRIANGLES
    };
    if (normals) prim.normals = normals;
    if (uvs)     prim.uvs     = uvs;
    if (indices) {
        prim.indices    = indices;
        prim.indexCount = indices.length;
    }
    return prim;
}

// ─── Internal: accessor → tight typed array ──────────────────────────────────

/**
 * Resolve a glTF accessor down to a single tightly-packed typed array.
 * Handles both contiguous and interleaved bufferViews, copying when needed
 * so the returned array is always safe to upload as a vertex attribute on its own.
 */
function readAccessor(json: any, bin: ArrayBuffer, accessorIndex: number): TypedArray {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor) throw new Error(`parseGLB: missing accessor ${accessorIndex}.`);

    const componentType = accessor.componentType as keyof typeof COMPONENT_TYPE_TO_ARRAY;
    const ArrayCtor = COMPONENT_TYPE_TO_ARRAY[componentType];
    if (!ArrayCtor) {
        throw new Error(`parseGLB: unsupported componentType ${accessor.componentType}.`);
    }

    const accessorType  = accessor.type as keyof typeof TYPE_TO_COMPONENTS;
    const numComponents = TYPE_TO_COMPONENTS[accessorType];
    if (numComponents === undefined) {
        throw new Error(`parseGLB: unsupported accessor type "${accessor.type}".`);
    }

    const componentBytes = COMPONENT_TYPE_TO_BYTES[componentType];
    const elementBytes   = componentBytes * numComponents;

    // Sparse accessors come without a bufferView; not supported here.
    if (accessor.bufferView === undefined) {
        throw new Error("parseGLB: sparse accessors are not supported.");
    }

    const bufferView = json.bufferViews?.[accessor.bufferView];
    if (!bufferView) {
        throw new Error(`parseGLB: missing bufferView ${accessor.bufferView}.`);
    }

    // Multi-buffer GLBs put the BIN chunk in buffer 0; everything else would
    // need an external .bin we don't load. Be explicit rather than silently wrong.
    if ((bufferView.buffer ?? 0) !== 0) {
        throw new Error(`parseGLB: bufferView references buffer ${bufferView.buffer} (only buffer 0 is supported).`);
    }

    const baseOffset    = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride        = bufferView.byteStride ?? elementBytes;
    const count         = accessor.count;
    const totalElements = count * numComponents;

    // Fast path: tightly packed and aligned to component size — view the BIN
    // directly without copying. (BIN chunk starts 0-aligned because slice() copies.)
    if (stride === elementBytes && baseOffset % componentBytes === 0) {
        // .slice() to detach from the BIN buffer — owners can keep the result
        // alive (or transfer it) without holding the whole GLB in memory.
        return new ArrayCtor(bin, baseOffset, totalElements).slice();
    }

    // Interleaved or misaligned: walk element-by-element, copying components.
    const out = new ArrayCtor(totalElements);
    const dv  = new DataView(bin);

    for (let i = 0; i < count; i++) {
        const srcOffset = baseOffset + i * stride;
        for (let j = 0; j < numComponents; j++) {
            const o = srcOffset + j * componentBytes;
            let v: number;
            switch (accessor.componentType) {
                case 5120: v = dv.getInt8(o);          break;
                case 5121: v = dv.getUint8(o);         break;
                case 5122: v = dv.getInt16(o,  true);  break;
                case 5123: v = dv.getUint16(o, true);  break;
                case 5125: v = dv.getUint32(o, true);  break;
                case 5126: v = dv.getFloat32(o, true); break;
                default:   throw new Error(`parseGLB: unsupported componentType ${accessor.componentType}.`);
            }
            out[i * numComponents + j] = v;
        }
    }
    return out;
}
