import { RenderObject, resizeCanvasToDisplaySize } from "./resources/webgl-utils"; 
import { RenderLoop } from "./resources/renderloop";
import * as twgl from "twgl.js";
import { InputManager } from "./resources/input-manager";

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

const objects: RenderObject[] = [];

function main() {
    if (!gl) {
        console.log("WebGL not supported");
        return;
    }

    resizeCanvasToDisplaySize(canvas);

    const loop = new RenderLoop(gl, canvas);

    // Helper: push u_resolution to all objects. Called on init and on resize.
    function updateResolution() {
        const res: [number, number] = [gl!.canvas.width, gl!.canvas.height];
        for (const obj of objects) {
            obj.setUniform("u_resolution", res);
        }
    }

    loop.onBeforeFrame = (gl, canvas) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };

    //store this here so that we can check the resolution changes first and then ask for u_res changes
    let lastWidth  = canvas.width;
    let lastHeight = canvas.height;

    const originalOnBeforeFrame = loop.onBeforeFrame!;
    loop.onBeforeFrame = (gl, canvas, time) => {
        originalOnBeforeFrame(gl, canvas, time);
        if (canvas.width !== lastWidth || canvas.height !== lastHeight) {
            lastWidth  = canvas.width;
            lastHeight = canvas.height;
            updateResolution();
        }
    };

    const sharedProgram = twgl.createProgramInfo(gl, [vertexShaderSource, fragmentShaderSource]);

    for (let i = 0; i < 100; i++) {
        let obj = new RenderObject(gl, sharedProgram);
        obj.setAttributeData("a_position", {
            data: setRectangle(gl, randomInt(canvas.width - 300), randomInt(canvas.height - 300), randomInt(300), randomInt(300)),
            size: 2,
            dynamic: true,
        });
        obj.setUniform("u_resolution", [gl.canvas.width, gl.canvas.height]);
        obj.setUniform("u_color", [Math.random(), Math.random(), Math.random(), 1]);
        obj.setCount(6);
        obj.uploadBuffers(); // explicit pre-upload before first frame
        objects.push(obj);
        loop.add(obj);
    }

    const input = new InputManager(canvas);
    loop.attachInput(input);

    loop.onInput = (input, time) => {
        if (input.isKeyPressed("KeyR")) {
            for (const obj of objects) {
                obj.setAttributeData("a_position", {
                    data: setRectangle(gl, randomInt(canvas.width - 300), randomInt(canvas.height - 300), randomInt(300), randomInt(300)),
                    size: 2,
                    dynamic: true,
                });
                // No uploadBuffers() call needed — draw() handles it automatically.
            }
            return true;
        }
    };

    loop.start();
    loop.requestRedraw();
}

main();