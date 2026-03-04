var canvas = document.getElementById('c');
var ctx = canvas.getContext('webgl2');
//gonna try webgl2 for the first time, wish me luck
var vertexShaderSource = "#version 300 es\n// an attribute is an input (in) to a vertex shader.\n// It will receive data from a buffer\nin vec4 a_position;\n\n// all shaders have a main function\nvoid main() {\n\n    // gl_Position is a special variable a vertex shader\n    // is responsible for setting\n    gl_Position = a_position;\n}\n";
var fragmentShaderSource = "#version 300 es\n\n// fragment shaders don't have a default precision so we need\n// to pick one. highp is a good default. It means \"high precision\"\nprecision highp float;\n\n// we need to declare an output for the fragment shader\nout vec4 outColor;\n\nvoid main() {\n    // Just set the output to a constant reddish-purple\n    outColor = vec4(1, 0, 0.5, 1);\n}\n";
// creates and compiles a shader
function createShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (success) {
        return shader;
    }
}
// creates a program from 2 shaders
function createProgram(gl, vertexShader, fragmentShader) {
    var program = gl.createProgram();
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
function drawScene() {
    if (!ctx)
        return;
}
//helper function
function resizeCanvasToDisplaySize(canvas) {
    var displayWidth = canvas.clientWidth;
    var displayHeight = canvas.clientHeight;
    var needResize = canvas.width !== displayWidth ||
        canvas.height !== displayHeight;
    if (needResize) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
    }
    return needResize;
}
//setting up shaders and buffers, only if ctx is not null
if (ctx) {
    var vertexShader = createShader(ctx, ctx.VERTEX_SHADER, vertexShaderSource);
    var fragmentShader = createShader(ctx, ctx.FRAGMENT_SHADER, fragmentShaderSource);
    var program = createProgram(ctx, vertexShader, fragmentShader);
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
    var size = 2; // 2 components per iteration it will take the x and y from the array and default for the z and w
    var type = ctx.FLOAT; // the data is 32bit floats
    var normalize = false; // don't normalize the data
    var stride = 0; // 0 = move forward size * sizeof(type) each iteration to get the next position
    var offset = 0; // start at the beginning of the buffer
    ctx.vertexAttribPointer(positionAttributeLocation, size, type, normalize, stride, offset);
    // draw
    resizeCanvasToDisplaySize(ctx.canvas);
    ctx.viewport(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    ctx.useProgram(program);
    ctx.bindVertexArray(vao);
    var primitiveType = ctx.TRIANGLES;
    var offset = 0;
    var count = 3;
    ctx.drawArrays(primitiveType, offset, count);
}
