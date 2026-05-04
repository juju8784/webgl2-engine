import { RenderObject, resizeCanvasToDisplaySize } from "./resources/webgl-utils";
import { RenderLoop } from "./resources/renderloop";
import * as twgl from "twgl.js";
import { InputManager } from "./resources/input-manager";
import { mat4 } from "gl-matrix";
import { parseGLB } from "./resources/glb-parser";

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
    out vec2 v_texcoord;
    out vec3 v_normal;
    out vec3 v_surfaceToLight;
    out vec3 v_surfaceToView;

    void main() {
        v_texcoord = a_texcoord;
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
    const cameraPosition: [number, number, number] = [0, 0, 3];
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
