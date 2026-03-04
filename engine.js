var canvas = document.getElementById('c');
var ctx = canvas.getContext('webgl2');
//gonna try webgl2 for the first time, wish me luck
var vertexShaderSource = "#version 300 es\n// an attribute is an input (in) to a vertex shader.\n// It will receive data from a buffer\n\n// using vec2 since we're only working in 2d\nin vec2 a_position;\n\n// a uniform is a global variable that is the same\n// using this to set the resolution of the canvas\nuniform vec2 u_resolution;\n\n// all shaders have a main function\nvoid main() {\n\n    // convert the position from pixels to 0.0 to 1.0\n    vec2 zeroToOne = a_position / u_resolution;\n\n    // convert from 0->1 to 0->2\n    vec2 zeroToTwo = zeroToOne * 2.0;\n\n    // convert from 0->2 to -1->+1 (clipspace)\n    vec2 clipSpace = zeroToTwo - 1.0;\n    // gl_Position is a special variable a vertex shader\n    // is responsible for setting\n    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);\n}\n";
var fragmentShaderSource = "#version 300 es\n\n// fragment shaders don't have a default precision so we need\n// to pick one. highp is a good default. It means \"high precision\"\nprecision highp float;\n\nuniform vec4 u_color;\n\n// we need to declare an output for the fragment shader\nout vec4 outColor;\n\nvoid main() {\n    // Just set the output to a constant reddish-purple\n    outColor = u_color;\n}\n";
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
//helper function to set rectangle vertices
function setRectangle(gl, x, y, width, height) {
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
function randomInt(range) {
    return Math.floor(Math.random() * range);
}
function main() {
    //setting up shaders and buffers, only if ctx is not null
    if (ctx) {
        var vertexShader = createShader(ctx, ctx.VERTEX_SHADER, vertexShaderSource);
        var fragmentShader = createShader(ctx, ctx.FRAGMENT_SHADER, fragmentShaderSource);
        var program = createProgram(ctx, vertexShader, fragmentShader);
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
        var size = 2; // 2 components per iteration it will take the x and y from the array and default for the z and w
        var type = ctx.FLOAT; // the data is 32bit floats
        var normalize = false; // don't normalize the data
        var stride = 0; // 0 = move forward size * sizeof(type) each iteration to get the next position
        var offset = 0; // start at the beginning of the buffer
        ctx.vertexAttribPointer(positionAttributeLocation, size, type, normalize, stride, offset);
        // draw
        // Resize the canvas to match the size it's displayed.
        resizeCanvasToDisplaySize(ctx.canvas);
        // Tell WebGL how to convert from clip space to pixels
        ctx.viewport(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.clearColor(0, 0, 0, 0);
        ctx.clear(ctx.COLOR_BUFFER_BIT);
        ctx.useProgram(program);
        // can only do this after using the program
        ctx.bindVertexArray(vao);
        ctx.uniform2f(resolutionUniformLocation, ctx.canvas.width, ctx.canvas.height);
        ctx.uniform4f(colorUniformLocation, Math.random(), Math.random(), Math.random(), 1);
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
        // var positions = [
        //     10, 20,
        //     80, 20,
        //     10, 30,
        //     10, 30,
        //     80, 20,
        //     80, 30,
        // ];
        // //this is using the position buffer that we just bound to the array buffer
        // ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array(positions), ctx.STATIC_DRAW);
        // var primitiveType = ctx.TRIANGLES;
        // var offset = 0;
        // var count = 6;
        // ctx.drawArrays(primitiveType, offset, count);
    }
}
main();
