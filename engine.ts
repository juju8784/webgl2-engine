import { RenderObject, resizeCanvasToDisplaySize } from "./resources/webgl-utils"; 
import { RenderLoop } from "./resources/renderloop";

// declare const glMatrix: {mat4: typeof import("gl-matrix")["mat4"]};
// const { mat4 } = glMatrix;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2');
//gonna try webgl2 for the first time, wish me luck

var vertexShaderSource = `#version 300 es
// an attribute is an input (in) to a vertex shader.
// It will receive data from a buffer

// using vec2 since we're only working in 2d
in vec2 a_position;
in vec4 a_color;

// a uniform is a global variable that is the same
// using this to set the resolution of the canvas
uniform vec2 u_resolution;

// all shaders have a main function
void main() {

    // convert the position from pixels to 0.0 to 1.0
    vec2 zeroToOne = a_position / u_resolution;

    // convert from 0->1 to 0->2
    vec2 zeroToTwo = zeroToOne * 2.0;

    // convert from 0->2 to -1->+1 (clipspace)
    vec2 clipSpace = zeroToTwo - 1.0;
    // gl_Position is a special variable a vertex shader
    // is responsible for setting
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
}
`;

var fragmentShaderSource = `#version 300 es

// fragment shaders don't have a default precision so we need
// to pick one. highp is a good default. It means "high precision"
precision highp float;

uniform vec4 u_color;

// we need to declare an output for the fragment shader
out vec4 outColor;

void main() {
    // Just set the output to a constant reddish-purple
    outColor = u_color;
}
`;

//helper function to set rectangle vertices
function setRectangle(gl: WebGL2RenderingContext, x: number, y: number, width: number, height: number)
{
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
//setting up shaders and buffers, only if ctx is not null
    if (!gl) {
        console.log("WebGL not supported");
        return;
    }

    resizeCanvasToDisplaySize(canvas);

    //create render loop
    const loop = new RenderLoop(gl, canvas);

    loop.onBeforeFrame = (gl, canvas) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const res: [number, number] = [gl.canvas.width, gl.canvas.height];
        for (const obj of objects)
        {
            obj.setUniform("u_resolution", res);
        }

    }

    for (let i = 0; i < 100; i++)
    {
        let obj = new RenderObject(gl, vertexShaderSource, fragmentShaderSource);
        obj.setAttributeData("a_position", {
            data: setRectangle(gl, randomInt(canvas.width - 300), randomInt(canvas.height - 300), randomInt(300), randomInt(300)),
            size: 2,
        });
        obj.setUniform("u_resolution", [gl.canvas.width, gl.canvas.height]);
        obj.setUniform("u_color", [Math.random(), Math.random(), Math.random(), 1]);
        obj.setCount(6);
        obj.uploadBuffers();
        objects.push(obj);
        loop.add(obj);
    }
    
    loop.start();

    loop.requestRedraw();
}

main();