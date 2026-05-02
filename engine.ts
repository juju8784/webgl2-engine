import { RenderObject, resizeCanvasToDisplaySize } from "./resources/webgl-utils";
import { RenderLoop } from "./resources/renderloop";
import * as twgl from "twgl.js";
import { InputManager } from "./resources/input-manager";
import { mat4 } from "gl-matrix";
import { parseGLB, type GLBPrimitive } from "./resources/glb-parser";

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

/**
 * Expand an indexed GLB primitive into flat per-vertex arrays for drawArrays.
 * RenderObject doesn't support index buffers yet; the next engine feature
 * (drawElements + ELEMENT_ARRAY_BUFFER) will let us drop this copy entirely.
 */
function expandIndexed(prim: GLBPrimitive): {
    positions: Float32Array;
    normals?:  Float32Array;
    count:     number;
} {
    if (!prim.indices) {
        const out: { positions: Float32Array; normals?: Float32Array; count: number } = {
            positions: prim.positions,
            count:     prim.vertexCount,
        };
        if (prim.normals) out.normals = prim.normals;
        return out;
    }

    const idx     = prim.indices;
    const srcPos  = prim.positions;
    const positions = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
        const v = idx[i]! * 3;
        positions[i * 3 + 0] = srcPos[v + 0]!;
        positions[i * 3 + 1] = srcPos[v + 1]!;
        positions[i * 3 + 2] = srcPos[v + 2]!;
    }

    let normals: Float32Array | undefined;
    if (prim.normals) {
        const srcN = prim.normals;
        normals = new Float32Array(idx.length * 3);
        for (let i = 0; i < idx.length; i++) {
            const v = idx[i]! * 3;
            normals[i * 3 + 0] = srcN[v + 0]!;
            normals[i * 3 + 1] = srcN[v + 1]!;
            normals[i * 3 + 2] = srcN[v + 2]!;
        }
    }

    const out: { positions: Float32Array; normals?: Float32Array; count: number } = {
        positions,
        count: idx.length,
    };
    if (normals) out.normals = normals;
    return out;
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
    const cameraPosition: [number, number, number] = [0, 0, 3];
    const target:         [number, number, number] = [0, 0, 0];
    const up:             [number, number, number] = [0, 1, 0];

    const cameraMatrix = mat4.create();
    mat4.targetTo(cameraMatrix, cameraPosition, target, up);
    const viewMatrix = mat4.create();
    mat4.invert(viewMatrix, cameraMatrix);

    // ── Load and prepare the sphere ──────────────────────────────────────
    const model = await parseGLB("models/sphere.glb");
    const prim  = model.meshes[0]?.primitives[0];
    if (!prim) throw new Error("sphere.glb has no mesh primitives.");
    const geo = expandIndexed(prim);

    const sharedProgram3D = twgl.createProgramInfo(gl, [vertexShader3D, fragShader3D]);
    const sphere = new RenderObject(gl, sharedProgram3D);
    sphere.setAttributeData("a_position", { data: geo.positions, size: 3 });
    if (geo.normals) {
        sphere.setAttributeData("a_normal", { data: geo.normals, size: 3 });
    }
    sphere.setUniform("u_colorMult", [1, 1, 1, 1]);
    sphere.setCount(geo.count);
    sphere.uploadBuffers();
    objects.push(sphere);

    // ── Render loop ──────────────────────────────────────────────────────
    const loop = new RenderLoop(gl, canvas);

    // Aspect-dependent uniforms (projection here) must be recomputed whenever
    // the canvas resizes, or the model stretches with the window.
    function updateProjection() {
        const aspect         = gl!.canvas.width / gl!.canvas.height;
        const projection     = mat4.create();
        const viewProjection = mat4.create();
        mat4.perspectiveNO(projection, Math.PI / 3, aspect, 0.1, 100);
        mat4.multiply(viewProjection, projection, viewMatrix);
        // Sphere's model matrix is identity, so final = viewProjection.
        sphere.setUniform("u_matrix", viewProjection);
    }
    updateProjection();

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

    const input = new InputManager(canvas);
    loop.attachInput(input);

    loop.start();
    loop.requestRedraw();
}

main();
