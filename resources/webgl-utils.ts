

// creates and compiles a shader
export function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
    var shader = gl.createShader(type) as WebGLShader;
    // set the shader source code.
    gl.shaderSource(shader, source);
    //compile the shader
    gl.compileShader(shader);

    // check if it compiled
    var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS); 
    if (!success)
    {
        throw ("could not compile shader:" + gl.getShaderInfoLog(shader));
    }
    return shader;
}

// creates a program from 2 shaders
export function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    var program = gl.createProgram() as WebGLProgram;

    // attach shaders
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    // link the program
    gl.linkProgram(program);

    var success = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!success) {
        throw ("program failed to link:" + gl.getProgramInfoLog(program));
    }
    return program;

}

// Combining common steps to create a program from shader sources
export function createProgramFromSources(gl: WebGL2RenderingContext, shaderSources: {vertex: string, fragment: string}) {
    var vertexShader = compileShader(gl, gl.VERTEX_SHADER, shaderSources.vertex);
    var fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, shaderSources.fragment);
    return createProgram(gl, vertexShader, fragmentShader);
}


//resizes the canvas to match the size it's displayed
//May need to handle the zoom level of the browser in the future, but for now this is sufficient
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement) {
    const displayWidth  = canvas.clientWidth * window.devicePixelRatio;
    const displayHeight = canvas.clientHeight * window.devicePixelRatio;
    const needResize =  canvas.width  !== displayWidth ||
                        canvas.height !== displayHeight;

    if (needResize) {
        canvas.width  = displayWidth;
        canvas.height = displayHeight;
    }
    return needResize;
}

class RenderObject {
    //the necessary
    ctx: WebGL2RenderingContext;
    program: WebGLProgram;


    vertexArray: WebGLVertexArrayObject;
    positionBuffer: WebGLBuffer;
    uniforms: WebGLActiveInfo[] = [];
    //positionbuffer create?

    //settings
    size: number;
    type: number;
    normalize: boolean;
    primitiveType: number;
    offset: number;
    count: number;

    constructor(ctx:WebGL2RenderingContext, program: WebGLProgram)
    {
        this.ctx = ctx;
        this.program = program;
    }

    //get all active uniforms in the current program
    setUniformInfo()
    {
        var numUniforms = this.ctx.getProgramParameter(this.program, this.ctx.ACTIVE_UNIFORMS);
        for (let i = 0; i < numUniforms; ++i)
        {
            const info = this.ctx.getActiveUniform(this.program, i) as WebGLActiveInfo;
            this.uniforms.push(info);
        }
    }

    //run draw logic for this object
    draw()
    {
        this.ctx.useProgram(this.program);
        this.ctx.bindVertexArray(this.vertexArray);
        
        //uniform logic

        this.ctx.bindBuffer(this.ctx.ARRAY_BUFFER, this.positionBuffer);
        //set vertex data


        this.ctx.drawArrays(this.primitiveType, this.offset, this.count);
    }

}