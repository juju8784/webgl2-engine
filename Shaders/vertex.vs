#version 300 es
// an attribute is an input (in) to a vertex shader.
// It will receive data from a buffer

// using vec2 since we're only working in 2d
in vec2 a_position;

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