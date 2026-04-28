import * as webGLUtils from './resources/webgl-utils.js';


// declare const glMatrix: {mat4: typeof import("gl-matrix")["mat4"]};
// const { mat4 } = glMatrix;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('webgl2');
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

    //this will bind to the current buffer so make sure you have the right one bound
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        x1, y1,
        x2, y1,
        x1, y2,
        x1, y2,
        x2, y1,
        x2, y2,
    ]), gl.STATIC_DRAW);
}

function randomInt(range: number) {
    return Math.floor(Math.random() * range);
}

//draw calls
function draw()
{
    // ctx?.clear(ctx.COLOR_BUFFER_BIT);
    // ctx?.useProgram(program);
    // ctx?.bindVertexArray(vao);
    // ctx?.uniform2f(resolutionUniformLocation, canvas.width, canvas.height);
    // ctx?.bindBuffer(ctx.ARRAY_BUFFER, positionBuffer);

    // ctx?.drawArrays(ctx.TRIANGLES, 0, 6);

}



function main() {
//setting up shaders and buffers, only if ctx is not null
    if (!ctx) {
        console.log("WebGL not supported");
        return;
    }

    
    var shaderSources = {
        vertex: vertexShaderSource,
        fragment: fragmentShaderSource
    };

    var program = webGLUtils.createProgramFromSources(ctx, shaderSources) as WebGLProgram;


    // using a_position because that's the name of the attribute in our vertex shader
    var positionAttributeLocation = ctx.getAttribLocation(program, "a_position");

    // look up uniform locations
    var resolutionUniformLocation = ctx.getUniformLocation(program, "u_resolution");
    var colorUniformLocation = ctx.getUniformLocation(program, "u_color");

    //Buffer
    var positionBuffer = ctx.createBuffer();

    // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
    ctx.bindBuffer(ctx.ARRAY_BUFFER, positionBuffer);
    
    
    var vao = ctx.createVertexArray();
    // bind to vao so that we affect its settings
    ctx.bindVertexArray(vao);

    // Turn on the attribute
    ctx.enableVertexAttribArray(positionAttributeLocation);
    // Settings
    var size = 2;          // 2 components per iteration it will take the x and y from the array and default for the z and w
    var type = ctx.FLOAT;  // the data is 32bit floats
    var normalize = false; // don't normalize the data
    var stride = 0;         // 0 = move forward size * sizeof(type) each iteration to get the next position
    var offset = 0;         // start at the beginning of the buffer
    ctx.vertexAttribPointer(positionAttributeLocation, size, type, normalize, stride, offset);
    
    console.log("Canvas size:", ctx.canvas.width, "x", ctx.canvas.height);
    console.log("Canvas client size:", canvas.clientWidth, "x", canvas.clientHeight);
    
    webGLUtils.resizeCanvasToDisplaySize(canvas);
    //console.log("Canvas size:", ctx.canvas.width, "x", ctx.canvas.height);
    //console.log("Canvas client size:", canvas.clientWidth * devicePixelRatio, "x", canvas.clientHeight * devicePixelRatio);
    
    // Tell WebGL how to convert from clip space to pixels
    ctx.viewport(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    
    ctx.useProgram(program);
    
    // can only do this after using the program
    ctx.bindVertexArray(vao);
    ctx.uniform2f(resolutionUniformLocation, ctx.canvas.width, ctx.canvas.height);
    
    // Rebind the buffer before updating it in the loop
    ctx.bindBuffer(ctx.ARRAY_BUFFER, positionBuffer);
    
    // draw 50 random rectangles in random colors
    for (var ii = 0; ii < 50; ii++) {
        // Set a random rectangle position.
        setRectangle(ctx, randomInt(300), randomInt(300), randomInt(300), randomInt(300));
        // Set a random color.
        ctx.uniform4f(colorUniformLocation, Math.random(), Math.random(), Math.random(), 1);
        
        // Draw the rectangle.
        var primitiveType = ctx.TRIANGLES;
        var offset = 0;
        var count = 6;
        ctx.drawArrays(primitiveType, offset, count);
    }
    var testObject = new webGLUtils.RenderObject(ctx, vertexShaderSource, fragmentShaderSource);
    console.log(testObject);
    
    // Resize the canvas to match the size it's displayed.
    const observer = new ResizeObserver(() => {
        webGLUtils.resizeCanvasToDisplaySize(canvas);
        ctx.viewport(0, 0, canvas.width, canvas.height);
        ctx.uniform2f(resolutionUniformLocation, canvas.width, canvas.height);
        //draw call
        //draw();
    })
    
    observer.observe(canvas);
}

main();