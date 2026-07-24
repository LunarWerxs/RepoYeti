// Monaco basic-language grammars — colorization only (Monarch tokenizers), no IntelliSense.
//
// Monaco 0.56 introduced supported, tree-shakeable entry points for its editor, features, and
// languages. The definitions barrel is exactly the old hand-maintained list of basic grammars,
// without the heavyweight TypeScript/CSS/HTML/JSON language services. Keeping the registration
// behind this tiny module preserves the lazy Monaco chunk while removing version-sensitive deep
// imports into Monaco's private ESM layout.
import "monaco-editor/languages/definitions/register.all";
