import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    mainFields: ['module', 'main'],
    platform: 'node',
    target: 'ES2020',
    sourcemap: !production,
    minify: production,
    loader: {
        '.glsl': 'text',
    },
}

if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log('Watching for changes...')
} else {
    await esbuild.build(buildOptions)
}
