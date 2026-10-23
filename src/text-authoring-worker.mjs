import {errorMessageData, messageError} from './localized-error.mjs';

/** Font parsing and portable outline layout never run on the interaction thread. */
import {
  createTextFigure,
  compileTextFigure,
  parseTextFont,
  MAX_FONT_BYTES,
} from "./text-authoring.mjs";
import {
  compileEmbeddedTextFigure,
  replaceTextAssetFigure,
  readTextFigureOptions,
} from "./native-text-authoring.mjs";

let source = null,
  nextFont = 1;
const fonts = new Map();
let retainedBytes = 0;
const MAX_RETAINED_FONT_BYTES = 64 * 1024 * 1024;
const describe = ({ family, style, bold, italic, name }, id) => ({
  id,
  family,
  style,
  bold,
  italic,
  name,
});

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    let value;
    if (type === "source") {
      source = data.figure || null;
      value = source ? readTextFigureOptions(source) : null;
    } else if (type === "font") {
      if (
        !(data.buffer instanceof ArrayBuffer) ||
        data.buffer.byteLength > MAX_FONT_BYTES
      )
        throw messageError(new Error(''), "errors.textAuthoringWorker.chooseATtfOrOtfFontSmallerThan", {});
      // Reject, rather than evict, a face which an open dialog could still reference.
      if (
        fonts.size >= 8 ||
        retainedBytes + data.buffer.byteLength > MAX_RETAINED_FONT_BYTES
      )
        throw messageError(new Error(''), "errors.textAuthoringWorker.thisSessionHasEnoughFontsLoadedCloseAnd", {});
      const face = parseTextFont(data.buffer, { name: data.name }),
        fontId = `font-${nextFont++}`;
      fonts.set(fontId, face);
      retainedBytes += data.buffer.byteLength;
      value = describe(face, fontId);
    } else if (type === "compile") {
      const options = data.options,
        mode = data.fontId || "bundled";
      if (mode === "embedded") {
        if (!source) throw messageError(new Error(''), "errors.textAuthoringWorker.thereIsNoEmbeddedTextToEdit", {});
        value = compileEmbeddedTextFigure(options, source);
      } else {
        const face = fonts.get(mode);
        if (mode !== "bundled" && !face)
          throw messageError(new Error(''), "errors.textAuthoringWorker.chooseAFontAgain", {});
        const compiled = face
          ? compileTextFigure(
              {
                ...options,
                fontFamily: face.family,
                bold: face.bold,
                italic: face.italic,
              },
              face.font,
            )
          : await createTextFigure({ ...options, fontFamily: "Noto Sans" });
        value = source
          ? replaceTextAssetFigure(source, compiled, {
              assetIndex: options.assetIndex,
            })
          : compiled;
        value._styk.textAuthoring.fontOrigin =
          mode === "bundled" ? "bundled" : "custom";
      }
    } else throw messageError(new Error(''), "errors.textAuthoringWorker.unknownTextAuthoringRequest", {});
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({
      id,
      error: {
        message: error.message, ...errorMessageData(error),
        name: error.name,
        missing: error.missing,
      },
    });
  }
};
