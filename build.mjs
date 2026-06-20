// Build via the esbuild JS API (not the inline CLI) so external package patterns
// like '@babylonjs/*' are passed as an array and never reach a shell for glob
// expansion. The previous `--external:@babylonjs/*` CLI flag was glob-expanded by
// the CI build shell ("No matches found") and failed the air-gapped builder.
// Mirrors the CamelC0re CCTestPlugin template (build.mjs + node build.mjs).
import * as esbuild from 'esbuild';
import fs from 'fs/promises';
import pkgJson from './package.json' with { type: 'json' };

// Inline + minify any imported CSS as a text module (matches the template).
const CSSMinifyPlugin = {
    name: 'CSSMinifyPlugin',
    setup(build) {
        build.onLoad({ filter: /\.css$/ }, async (args) => {
            const f = await fs.readFile(args.path);
            const css = await esbuild.transform(f, { loader: 'css', minify: true });
            return { loader: 'text', contents: css.code };
        });
    },
};

await esbuild.build({
    entryPoints: [pkgJson.main],
    outfile: pkgJson.evillite.entry,
    bundle: true,
    minify: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    // The client supplies these at runtime; never bundle them. Patterns are matched
    // by esbuild itself, so the '*' is safe here (no shell involved).
    external: ['@evillite/core', '@babylonjs/*'],
    plugins: [CSSMinifyPlugin],
    loader: {
        '.html': 'text',
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.jpeg': 'dataurl',
        '.gif': 'dataurl',
        '.svg': 'dataurl',
        '.webp': 'dataurl',
        '.wav': 'dataurl',
        '.mp3': 'dataurl',
    },
});
