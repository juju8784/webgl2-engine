/**
 * Minimal custom GLB (glTF 2.0 binary) parser.
 *
 * Extracts mesh primitives, materials, and textures in a form ready to feed
 * straight into RenderObject.setAttributeData / setIndices and WebGL2 texture
 * uploads:
 *
 *   const model = await parseGLB("models/sphere.glb");
 *   const prim  = model.meshes[0].primitives[0];
 *
 *   obj.setAttributeData("a_position", { data: prim.positions, size: 3 });
 *   if (prim.normals) obj.setAttributeData("a_normal", { data: prim.normals, size: 3 });
 *   if (prim.uvs)     obj.setAttributeData("a_uv",     { data: prim.uvs,     size: 2 });
 *
 *   if (prim.materialIndex !== undefined) {
 *       const mat = model.materials[prim.materialIndex];
 *       if (mat.baseColorTexture !== undefined) {
 *           const tex     = model.textures[mat.baseColorTexture.index];
 *           const bitmap  = model.images[tex.imageIndex].bitmap;
 *           const sampler = tex.samplerIndex !== undefined
 *               ? model.samplers[tex.samplerIndex]
 *               : DEFAULT_SAMPLER;
 *           // gl.texImage2D(..., bitmap); gl.texParameteri(..., sampler.minFilter); etc.
 *       }
 *   }
 *
 * Supports:
 *   - GLB version 2 with one BIN chunk (the common case).
 *   - POSITION / NORMAL / TEXCOORD_0 attributes.
 *   - Indexed and non-indexed primitives (UNSIGNED_SHORT / UNSIGNED_INT).
 *   - Interleaved bufferViews (de-interleaves into tight arrays).
 *   - PBR baseColorTexture + baseColorFactor materials.
 *   - PNG / JPEG images embedded in the BIN chunk, decoded to ImageBitmap.
 *   - Samplers exposed as raw WebGL2 enums (filters + wrap modes).
 *
 * Out of scope (intentionally — keep it small for now):
 *   - External .bin/.gltf files and data-URI images (we only handle self-contained .glb).
 *   - Other PBR textures (metallicRoughness, normal, occlusion, emissive).
 *   - Tangents, colors, joints/weights, multiple UV sets.
 *   - Skins, animations, scene graph traversal.
 *   - Sparse accessors and morph targets.
 *   - Compressed textures (KTX2 / Basis / DDS).
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
    positions:      Float32Array;
    normals?:       Float32Array;
    uvs?:           Float32Array;
    indices?:       Uint16Array | Uint32Array;
    vertexCount:    number;
    indexCount?:    number;
    /** GL primitive mode (default 4 = TRIANGLES, per glTF spec). */
    mode:           number;
    /** Index into GLBModel.materials. Undefined → use default material. */
    materialIndex?: number;
}

export interface GLBMesh {
    name?:       string;
    primitives:  GLBPrimitive[];
}

/** Decoded image, ready to upload via gl.texImage2D(..., bitmap). */
export interface GLBImage {
    bitmap:    ImageBitmap;
    mimeType:  string;
    name?:     string;
}

/**
 * WebGL2 sampler state. Values are the raw GL enum integers
 * (which are also exactly what glTF stores in JSON).
 */
export interface GLBSampler {
    /** TEXTURE_MAG_FILTER: 9728 NEAREST, 9729 LINEAR. */
    magFilter: number;
    /** TEXTURE_MIN_FILTER: 9728/9729/9984/9985/9986/9987. */
    minFilter: number;
    /** TEXTURE_WRAP_S: 10497 REPEAT, 33071 CLAMP_TO_EDGE, 33648 MIRRORED_REPEAT. */
    wrapS:     number;
    /** TEXTURE_WRAP_T. */
    wrapT:     number;
}

/**
 * Default sampler, applied when a glTF texture omits its sampler reference.
 * Per the glTF 2.0 spec the wrap mode defaults are REPEAT and the filters are
 * "implementation-defined" — LINEAR + LINEAR_MIPMAP_LINEAR is the standard pick.
 */
export const DEFAULT_SAMPLER: GLBSampler = {
    magFilter: 9729,  // LINEAR
    minFilter: 9987,  // LINEAR_MIPMAP_LINEAR
    wrapS:     10497, // REPEAT
    wrapT:     10497, // REPEAT
};

export interface GLBTexture {
    imageIndex:    number;
    /** Undefined → use DEFAULT_SAMPLER. */
    samplerIndex?: number;
}

export interface GLBTextureRef {
    /** Index into GLBModel.textures. */
    index:    number;
    /** Which UV set on the primitive feeds this texture (0 → uvs / TEXCOORD_0). */
    texCoord: number;
}

export interface GLBMaterial {
    name?:             string;
    /** RGBA, linear, multiplied with the baseColorTexture sample (default [1,1,1,1]). */
    baseColorFactor:   [number, number, number, number];
    baseColorTexture?: GLBTextureRef;
}

export interface GLBModel {
    meshes:    GLBMesh[];
    materials: GLBMaterial[];
    textures:  GLBTexture[];
    images:    GLBImage[];
    samplers:  GLBSampler[];
    /** Raw glTF JSON, exposed for callers that need extras (nodes, scenes, …). */
    json:      any;
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
 *
 * Async because image decoding via createImageBitmap is async.
 */
export async function parseGLBBuffer(buffer: ArrayBuffer): Promise<GLBModel> {
    const { json, bin } = readGLBChunks(buffer);
    if (!bin) {
        throw new Error("parseGLB: file has no BIN chunk (external .bin not supported).");
    }

    // Decode images first — primitives/materials/textures are all sync to build.
    const images   = await readImages(json, bin);
    const samplers = readSamplers(json);
    const textures = readTextures(json);
    const materials = readMaterials(json);

    const meshes: GLBMesh[] = [];
    for (const meshDef of json.meshes ?? []) {
        const primitives: GLBPrimitive[] = [];
        for (const primDef of meshDef.primitives ?? []) {
            primitives.push(readPrimitive(json, bin, primDef));
        }
        meshes.push({ name: meshDef.name, primitives });
    }

    return { meshes, materials, textures, images, samplers, json };
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
    if (primDef.material !== undefined) {
        prim.materialIndex = primDef.material;
    }
    return prim;
}

// ─── Internal: images ────────────────────────────────────────────────────────

/**
 * Decode every glTF image into an ImageBitmap. We only support images stored
 * in a bufferView (the GLB-embedded case); `image.uri` (external file or data
 * URI) throws — by design for now.
 */
async function readImages(json: any, bin: ArrayBuffer): Promise<GLBImage[]> {
    const defs: any[] = json.images ?? [];
    if (defs.length === 0) return [];

    return Promise.all(defs.map(async (def, i): Promise<GLBImage> => {
        if (def.uri !== undefined) {
            throw new Error(`parseGLB: image ${i} uses uri (external/data-URI images not supported).`);
        }
        if (def.bufferView === undefined) {
            throw new Error(`parseGLB: image ${i} has neither uri nor bufferView.`);
        }

        const bv = json.bufferViews?.[def.bufferView];
        if (!bv) throw new Error(`parseGLB: image ${i} references missing bufferView ${def.bufferView}.`);
        if ((bv.buffer ?? 0) !== 0) {
            throw new Error(`parseGLB: image ${i} references buffer ${bv.buffer} (only buffer 0 is supported).`);
        }

        const mimeType = def.mimeType ?? sniffImageMime(bin, bv.byteOffset ?? 0);
        if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
            throw new Error(`parseGLB: image ${i} has unsupported mime type "${mimeType}" (only PNG/JPEG).`);
        }

        const bytes  = new Uint8Array(bin, bv.byteOffset ?? 0, bv.byteLength);
        const blob   = new Blob([bytes], { type: mimeType });
        const bitmap = await createImageBitmap(blob);

        const out: GLBImage = { bitmap, mimeType };
        if (def.name !== undefined) out.name = def.name;
        return out;
    }));
}

/** Sniff PNG/JPEG by magic bytes when image.mimeType is omitted. */
function sniffImageMime(bin: ArrayBuffer, offset: number): string {
    const v = new DataView(bin, offset);
    // PNG: 89 50 4E 47
    if (v.getUint32(0, false) === 0x89504e47) return "image/png";
    // JPEG: FF D8 FF
    if ((v.getUint32(0, false) >>> 8) === 0xffd8ff) return "image/jpeg";
    return "application/octet-stream";
}

// ─── Internal: samplers / textures / materials ───────────────────────────────

function readSamplers(json: any): GLBSampler[] {
    return (json.samplers ?? []).map((s: any): GLBSampler => ({
        magFilter: s.magFilter ?? DEFAULT_SAMPLER.magFilter,
        minFilter: s.minFilter ?? DEFAULT_SAMPLER.minFilter,
        wrapS:     s.wrapS     ?? DEFAULT_SAMPLER.wrapS,
        wrapT:     s.wrapT     ?? DEFAULT_SAMPLER.wrapT,
    }));
}

function readTextures(json: any): GLBTexture[] {
    return (json.textures ?? []).map((t: any, i: number): GLBTexture => {
        if (t.source === undefined) {
            throw new Error(`parseGLB: texture ${i} has no source image.`);
        }
        const out: GLBTexture = { imageIndex: t.source };
        if (t.sampler !== undefined) out.samplerIndex = t.sampler;
        return out;
    });
}

function readMaterials(json: any): GLBMaterial[] {
    return (json.materials ?? []).map((m: any): GLBMaterial => {
        const pbr = m.pbrMetallicRoughness ?? {};
        const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];

        const mat: GLBMaterial = {
            baseColorFactor: [factor[0], factor[1], factor[2], factor[3]],
        };
        if (m.name !== undefined) mat.name = m.name;
        if (pbr.baseColorTexture) {
            mat.baseColorTexture = {
                index:    pbr.baseColorTexture.index,
                texCoord: pbr.baseColorTexture.texCoord ?? 0,
            };
        }
        return mat;
    });
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
