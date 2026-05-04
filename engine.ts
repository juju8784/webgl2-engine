import { RenderObject, resizeCanvasToDisplaySize, createTexture } from "./resources/webgl-utils";
import { RenderLoop } from "./resources/renderloop";
import * as twgl from "twgl.js";
import { InputManager } from "./resources/input-manager";
import { mat4 } from "gl-matrix";
import { parseGLB, DEFAULT_SAMPLER } from "./resources/glb-parser";

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2');

var vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec4 a_color;

uniform vec2 u_resolution;

void main() {
    vec2 zeroToOne = a_position / u_resolution;
    vec2 zeroToTwo = zeroToOne * 2.0;
    vec2 clipSpace = zeroToTwo - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
}
`;

var fragmentShaderSource = `#version 300 es
precision highp float;

uniform vec4 u_color;

out vec4 outColor;

void main() {
    outColor = u_color;
}
`;

var vertexShader3D = `#version 300 es
in vec3 a_position;
in vec3 a_normal;

uniform mat4 u_matrix;

out vec3 v_normal;

void main() {
    gl_Position = u_matrix * vec4(a_position, 1.0);

    // Pass the normal through; the frag shader visualizes it as color.
    v_normal = a_normal;
}
`

var fragShader3D = `#version 300 es
    precision highp float;

    in vec3 v_normal;

    uniform vec4 u_colorMult;

    out vec4 outColor;

    void main() {
        // Remap normal from [-1, 1] to [0, 1] so it can be used as RGB.
        // Classic "show me the normals" debug view — and a quick visual
        // sanity check that POSITION + NORMAL parsed out of the GLB correctly.
        vec3 n = normalize(v_normal) * 0.5 + 0.5;
        outColor = vec4(n, 1.0) * u_colorMult;
    }
`;

var vertexShader3DTexture = `#version 300 es
    uniform mat4 u_worldViewProjection;
    uniform vec3 u_lightWorldPos;
    uniform mat4 u_world;
    uniform mat4 u_viewInverse;
    uniform mat4 u_worldInverseTranspose;

    in vec3 a_position;
    in vec3 a_normal;
    in vec2 a_texcoord;

    out vec4 v_position;
    out vec2 v_texCoord;
    out vec3 v_normal;
    out vec3 v_surfaceToLight;
    out vec3 v_surfaceToView;

    void main() {
        v_texCoord = a_texcoord;
        v_position = (u_worldViewProjection * vec4(a_position, 1.0));
        v_normal = (u_worldInverseTranspose * vec4(a_normal, 0.0)).xyz;
        v_surfaceToLight = u_lightWorldPos - (u_world * vec4(a_position, 1.0)).xyz;
        v_surfaceToView = u_viewInverse[3].xyz - (u_world * vec4(a_position, 1.0)).xyz;
        gl_Position = v_position;
    }
`;

var fragShader3DTexture = `#version 300 es
    precision highp float;
    
    in vec4 v_position;
    in vec2 v_texCoord;
    in vec3 v_normal;
    in vec3 v_surfaceToLight;
    in vec3 v_surfaceToView;
    
    uniform vec4 u_lightColor;
    uniform vec4 u_ambient;
    //potentially add a u_ambientLightColor
    uniform sampler2D u_diffuse;
    uniform vec4 u_specular;
    uniform float u_shininess;
    uniform float u_specularFactor;
    
    out vec4 outColor;
    
    vec4 lit(float l ,float h, float m) {
    return vec4(1.0,
                max(l, 0.0),
                (l > 0.0) ? pow(max(0.0, h), m) : 0.0,
                1.0);
    }
    
    void main() {
    vec4 diffuseColor = texture(u_diffuse, v_texCoord);
    vec3 a_normal = normalize(v_normal);
    vec3 surfaceToLight = normalize(v_surfaceToLight);
    vec3 surfaceToView = normalize(v_surfaceToView);
    vec3 halfVector = normalize(surfaceToLight + surfaceToView);
    vec4 litR = lit(dot(a_normal, surfaceToLight),
                        dot(a_normal, halfVector), u_shininess);
    outColor = vec4((
        u_lightColor * (diffuseColor * litR.y + diffuseColor * u_ambient +
        u_specular * litR.z * u_specularFactor)).rgb,
        diffuseColor.a);
    }
`;


function setRectangle(gl: WebGL2RenderingContext, x: number, y: number, width: number, height: number) {
    var x1 = x;
    var x2 = x + width;
    var y1 = y;
    var y2 = y + height;

    return new Float32Array([
        x1, y1,
        x2, y1,
        x1, y2,
        x1, y2,
        x2, y1,
        x2, y2,
    ]);
}

function randomInt(range: number) {
    return Math.floor(Math.random() * range);
}

function computeMatrix(viewProjectionMatrix: mat4, translation: number[], xRotation: number, yRotation: number)
{
    var matrix = mat4.create();
    mat4.translate(matrix, viewProjectionMatrix, translation);
    mat4.rotateX(matrix, matrix, xRotation);
    mat4.rotateY(matrix, matrix, yRotation);
    return matrix;
}

const objects: RenderObject[] = [];

async function main() {
    if (!gl) {
        console.log("WebGL not supported");
        return;
    }

    resizeCanvasToDisplaySize(canvas);

    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);

    // ── Camera (static for now) ──────────────────────────────────────────
    // Sphere is unit-radius at the origin → sit the camera a few units back.
    const cameraPosition: [number, number, number] = [0, 0, 10];
    const target:         [number, number, number] = [0, 0, 0];
    const up:             [number, number, number] = [0, 1, 0];

    const cameraMatrix = mat4.create();
    mat4.targetTo(cameraMatrix, cameraPosition, target, up);
    const viewMatrix = mat4.create();
    mat4.invert(viewMatrix, cameraMatrix);

    // ── Load and prepare the sphere ──────────────────────────────────────
    const model = await parseGLB("models/sphererough.glb");
    const prim  = model.meshes[0]?.primitives[0];
    if (!prim) throw new Error("sphere.glb has no mesh primitives.");

    const sharedProgram3D = twgl.createProgramInfo(gl, [vertexShader3D, fragShader3D]);
    const sphere = new RenderObject(gl, sharedProgram3D);
    sphere.setAttributeData("a_position", { data: prim.positions, size: 3 });
    if (prim.normals) {
        sphere.setAttributeData("a_normal", { data: prim.normals, size: 3 });
    }
    sphere.setUniform("u_colorMult", [1, 1, 1, 1]);
    if (prim.indices) {
        sphere.setIndices(prim.indices);  // also sets count = indices.length
    } else {
        sphere.setCount(prim.vertexCount);
    }
    sphere.uploadBuffers();
    objects.push(sphere);

    // ── Load and prepare miku ────────────────────────────────────────────
    const mikuModel = await parseGLB('models/hatsune_miku.glb');

    // Diagnostic: dump everything the parser found so we can tell whether the
    // model is a single mega-primitive, dozens of small ones, or something
    // weirder. Also report position bounds — if miku is millimeter-scale or
    // 1000-unit-scale she'll be invisible at our camera distance.
    console.log("miku meshes:", mikuModel.meshes.length,
                "materials:",   mikuModel.materials.length,
                "textures:",    mikuModel.textures.length,
                "images:",      mikuModel.images.length);
    let totalVerts = 0, totalIdx = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let m = 0; m < mikuModel.meshes.length; m++) {
        const mesh = mikuModel.meshes[m]!;
        for (let p = 0; p < mesh.primitives.length; p++) {
            const pr = mesh.primitives[p]!;
            totalVerts += pr.vertexCount;
            totalIdx   += pr.indexCount ?? 0;
            for (let i = 0; i < pr.positions.length; i += 3) {
                const x = pr.positions[i]!, y = pr.positions[i+1]!, z = pr.positions[i+2]!;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            console.log(`  mesh[${m}].prim[${p}] verts=${pr.vertexCount} idx=${pr.indexCount ?? 0} uvs=${!!pr.uvs} matIdx=${pr.materialIndex}`);
        }
    }
    console.log(`miku totals: verts=${totalVerts} idx=${totalIdx} bounds X[${minX.toFixed(2)},${maxX.toFixed(2)}] Y[${minY.toFixed(2)},${maxY.toFixed(2)}] Z[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`);

    // Build one RenderObject per primitive; share the program across all of them.
    const sharedProgram3DTexture = twgl.createProgramInfo(gl, [vertexShader3DTexture, fragShader3DTexture]);

    // Cache GL textures by image index — multiple primitives often share one.
    const textureCache = new Map<number, WebGLTexture>();
    const getTexture = (matIndex: number): WebGLTexture | null => {
        const m = mikuModel.materials[matIndex];
        if (!m?.baseColorTexture) return null;
        const t = mikuModel.textures[m.baseColorTexture.index]!;
        let cached = textureCache.get(t.imageIndex);
        if (cached) return cached;
        const img = mikuModel.images[t.imageIndex]!;
        const samp = t.samplerIndex !== undefined
            ? mikuModel.samplers[t.samplerIndex]!
            : DEFAULT_SAMPLER;
        cached = createTexture(gl, img.bitmap, samp);
        textureCache.set(t.imageIndex, cached);
        return cached;
    };

    // Miku's model matrix. Source bounds: Y[0.02, 20.43], X[-7.08, 7.08],
    // Z[-4.86, 2.20] — feet at origin, ~20 units tall. Scale 0.1 → 2 units tall,
    // then translate down so she's vertically centered next to the sphere.
    const mikuWorld = mat4.create();
    mat4.translate(mikuWorld, mikuWorld, [2.0, -1, 0]);
    mat4.scale(mikuWorld, mikuWorld, [0.1, 0.1, 0.1]);

    const mikuWorldIT = mat4.create();
    mat4.invert(mikuWorldIT, mikuWorld);
    mat4.transpose(mikuWorldIT, mikuWorldIT);

    // Track the per-primitive RenderObjects so updateProjection() can update them all.
    const mikuObjects: RenderObject[] = [];

    for (const mesh of mikuModel.meshes) {
        for (const pr of mesh.primitives) {
            if (!pr.uvs) {
                console.warn("  skipping primitive without UVs");
                continue;
            }
            if (pr.materialIndex === undefined) {
                console.warn("  skipping primitive without material");
                continue;
            }
            const tex = getTexture(pr.materialIndex);
            if (!tex) {
                console.warn(`  skipping primitive — material ${pr.materialIndex} has no baseColorTexture`);
                continue;
            }

            const obj = new RenderObject(gl, sharedProgram3DTexture);
            obj.setAttributeData("a_position", { data: pr.positions, size: 3 });
            if (pr.normals) obj.setAttributeData("a_normal", { data: pr.normals, size: 3 });
            obj.setAttributeData("a_texcoord", { data: pr.uvs, size: 2 });
            if (pr.indices) obj.setIndices(pr.indices);
            else            obj.setCount(pr.vertexCount);

            obj.setUniforms({
                u_diffuse:               tex,
                u_lightWorldPos:         [2, 3, 4],
                u_lightColor:            [1, 1, 1, 1],
                u_ambient:               [0.2, 0.2, 0.2, 1],
                u_specular:              [1, 1, 1, 1],
                u_shininess:             50,
                u_specularFactor:        1,
                u_world:                 mikuWorld,
                u_viewInverse:           cameraMatrix,
                u_worldInverseTranspose: mikuWorldIT,
            });

            obj.uploadBuffers();
            mikuObjects.push(obj);
            objects.push(obj);
        }
    }
    console.log(`miku: built ${mikuObjects.length} render objects.`);

    // ── Render loop ──────────────────────────────────────────────────────
    const loop = new RenderLoop(gl, canvas);

    // viewProjection is rebuilt on resize; everything per-frame multiplies into it.
    const viewProjection = mat4.create();
    function updateProjection() {
        const aspect     = gl!.canvas.width / gl!.canvas.height;
        const projection = mat4.create();
        mat4.perspectiveNO(projection, Math.PI / 3, aspect, 0.1, 100);
        mat4.multiply(viewProjection, projection, viewMatrix);
    }
    updateProjection();

    // ── Per-frame rotation ───────────────────────────────────────────────
    // Allocate matrices once and reuse them every frame to avoid GC churn.
    const sphereWorld = mat4.create();
    const sphereMVP   = mat4.create();
    const mikuWorldF  = mat4.create();
    const mikuMVP     = mat4.create();
    const mikuWorldITF = mat4.create();
    const SPHERE_RPS = 0.3; // radians per second
    const MIKU_RPS   = 0.4;
    let lastTime: number | null = null;
    let sphereAngle = 0;
    let mikuAngle   = 0;

    loop.onInput = (_state, time) => {
        const tSec = time / 1000;
        const dt   = lastTime === null ? 0 : tSec - lastTime;
        lastTime   = tSec;
        sphereAngle += dt * SPHERE_RPS;
        mikuAngle   += dt * MIKU_RPS;

        // Sphere: world = rotateY(angle), centered at origin.
        mat4.identity(sphereWorld);
        mat4.rotateY(sphereWorld, sphereWorld, sphereAngle);
        mat4.multiply(sphereMVP, viewProjection, sphereWorld);
        sphere.setUniform("u_matrix", sphereMVP);

        // Miku: world = translate * rotateY * scale.
        // Order matters — apply scale first (innermost), then rotate her in
        // place around her feet, then translate into world position.
        mat4.identity(mikuWorldF);
        mat4.translate(mikuWorldF, mikuWorldF, [2.0, -1, 0]);
        mat4.rotateY(mikuWorldF, mikuWorldF, mikuAngle);
        mat4.scale(mikuWorldF, mikuWorldF, [0.1, 0.1, 0.1]);
        mat4.multiply(mikuMVP, viewProjection, mikuWorldF);
        mat4.invert(mikuWorldITF, mikuWorldF);
        mat4.transpose(mikuWorldITF, mikuWorldITF);
        for (const obj of mikuObjects) {
            obj.setUniform("u_world",                 mikuWorldF);
            obj.setUniform("u_worldViewProjection",   mikuMVP);
            obj.setUniform("u_worldInverseTranspose", mikuWorldITF);
        }

        return true; // continuous animation — redraw every frame
    };

    loop.onBeforeFrame = (gl, canvas) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };

    // Watch backing-store size so resize-driven matrix updates only fire
    // when canvas dimensions actually change.
    let lastWidth  = canvas.width;
    let lastHeight = canvas.height;
    const originalOnBeforeFrame = loop.onBeforeFrame!;
    loop.onBeforeFrame = (gl, canvas, time) => {
        originalOnBeforeFrame(gl, canvas, time);
        if (canvas.width !== lastWidth || canvas.height !== lastHeight) {
            lastWidth  = canvas.width;
            lastHeight = canvas.height;
            updateProjection();
        }
    };

    loop.add(sphere);
    for (const obj of mikuObjects) loop.add(obj);

    const input = new InputManager(canvas);
    loop.attachInput(input);

    loop.start();
    loop.requestRedraw();
}

main();
