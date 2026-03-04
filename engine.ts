

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('webgl2');
//gonna try webgl2 for the first time, wish me luck

var vertexShaderSource = `#version 300 es
// an attribute is an input (in) to a vertex shader.
// It will receive data from a buffer
in vec4 a_position;

// all shaders have a main function
void main() {

    // gl_Position is a special variable a vertex shader
    // is responsible for setting
    gl_Position = a_position;
}
`;

var fragmentShaderSource = `#version 300 es

// fragment shaders don't have a default precision so we need
// to pick one. highp is a good default. It means "high precision"
precision highp float;

// we need to declare an output for the fragment shader
out vec4 outColor;

void main() {
    // Just set the output to a constant reddish-purple
    outColor = vec4(1, 0, 0.5, 1);
}
`;


// creates and compiles a shader
function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
    var shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    
    if (success)
    {
        return shader;
    }
}


// creates a program from 2 shaders
function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    var program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    var success = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (success) {
        return program;
    }

    console.log(gl.getProgramInfoLog(program));
    gl.deleteProgram(program);

}


// Draw the scene. call only once ctx is not null
function drawScene()
{
    if (!ctx) return;
    
}

//helper function
function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement) {
    const displayWidth  = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    const needResize =  canvas.width  !== displayWidth ||
                        canvas.height !== displayHeight;

    if (needResize) {
        canvas.width  = displayWidth;
        canvas.height = displayHeight;
    }
    return needResize;
}

function main() {
//setting up shaders and buffers, only if ctx is not null
    if (ctx) {
        var vertexShader = createShader(ctx, ctx.VERTEX_SHADER, vertexShaderSource) as WebGLShader;
        var fragmentShader = createShader(ctx, ctx.FRAGMENT_SHADER, fragmentShaderSource) as WebGLShader;

        var program = createProgram(ctx, vertexShader, fragmentShader) as WebGLProgram;


        // using a_position because that's the name of the attribute in our vertex shader
        var positionAttributeLocation = ctx.getAttribLocation(program, "a_position");


        //Buffer
        var positionBuffer = ctx.createBuffer();

        // Bind it to ARRAY_BUFFER (think of it as ARRAY_BUFFER = positionBuffer)
        ctx.bindBuffer(ctx.ARRAY_BUFFER, positionBuffer);


        // triangle time!

        var positions = [
            0, 0,
            0, 0.5,
            0.7, 0,
        ];
        //this is using the position buffer that we just bound to the array buffer
        ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array(positions), ctx.STATIC_DRAW);

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


        // draw
        // Resize the canvas to match the size it's displayed.
        resizeCanvasToDisplaySize(ctx.canvas as HTMLCanvasElement);

        // Tell WebGL how to convert from clip space to pixels
        ctx.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height);

        ctx.clearColor(0, 0, 0, 0);
        ctx.clear(ctx.COLOR_BUFFER_BIT);

        ctx.useProgram(program);
        ctx.bindVertexArray(vao);

        var primitiveType = ctx.TRIANGLES;
        var offset = 0;
        var count = 3;
        ctx.drawArrays(primitiveType, offset, count);
    }
}

main();