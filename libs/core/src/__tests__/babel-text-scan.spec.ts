/**
 * Text scans of the Babel path
 *
 * What the scans recognise: the import specifiers of a source file, the import statements whose
 * path is updated in Babel's output, a file extension, a stack location in an error message.
 */

import { findImportSources, hasFileExtension, mapStaticImportSources, removeStackLocations } from '../babel/text-scan';
import { createRestrictedBabel, resetBabelContext } from '../babel';

describe('Babel text scans', () => {
  describe('findImportSources', () => {
    it('should find the specifier of every form of static import', () => {
      const code = `
        import a from './a';
        import { b, c } from "./b";
        import * as d from './d';
        import e, { f } from './e';
        import './side-effect';
        import type { T } from './types';
      `;

      expect(findImportSources(code)).toEqual(['./a', './b', './d', './e', './side-effect', './types']);
    });

    it('should find imports that span lines', () => {
      const code = `import {\n  a,\n  b,\n} from\n  './multi';`;

      expect(findImportSources(code)).toEqual(['./multi']);
    });

    it('should find dynamic imports written with a string, after the static ones', () => {
      const code = `const later = () => import('./later');\nimport now from './now';\nimport ( "./spaced" );`;

      // A dynamic import is seen by both passes
      expect(findImportSources(code)).toEqual(['./later', './now', './spaced', './later', './spaced']);
    });

    it('should not take a longer word for the keyword', () => {
      expect(findImportSources(`const important = 'x'; imports('y');`)).toEqual([]);
    });

    it('should skip an empty specifier and go on', () => {
      expect(findImportSources(`import '' ; import './next';`)).toEqual(['./next']);
    });

    it('should return nothing for text without imports', () => {
      expect(findImportSources('')).toEqual([]);
      expect(findImportSources('const a = 1;')).toEqual([]);
      expect(findImportSources('import')).toEqual([]);
      expect(findImportSources(`import x from './unterminated`)).toEqual([]);
    });
  });

  describe('mapStaticImportSources', () => {
    const mark = (code: string) => mapStaticImportSources(code, (source) => `<${source}>`);

    it('should map the specifier of import statements', () => {
      expect(mark(`import a from './a';`)).toBe(`import a from '<./a>';`);
      expect(mark(`import { b, c } from "./b";`)).toBe(`import { b, c } from "<./b>";`);
      expect(mark(`import * as d from './d';`)).toBe(`import * as d from '<./d>';`);
      expect(mark(`import './side-effect';`)).toBe(`import '<./side-effect>';`);
      expect(mark(`import {\n  a,\n} from\n'./multi';`)).toBe(`import {\n  a,\n} from\n'<./multi>';`);
    });

    it('should map every import of a file and keep the rest of the text', () => {
      const code = `// header\nimport a from './a';\nconst x = 1;\nimport b from './b';\n// footer`;

      expect(mark(code)).toBe(`// header\nimport a from '<./a>';\nconst x = 1;\nimport b from '<./b>';\n// footer`);
    });

    it('should leave re-exports, dynamic imports and other text alone', () => {
      for (const code of [
        `export * from './a';`,
        `export { a } from './a';`,
        `const m = import('./a');`,
        `const text = 'no import here';`,
        `import a from './unterminated`,
        `import a from '';`,
        `importa from './a';`,
        '',
      ]) {
        expect(mark(code)).toBe(code);
      }
    });

    it('should return the same text when no specifier changes', () => {
      const code = `import a from './a';`;

      expect(mapStaticImportSources(code, (source) => source)).toBe(code);
    });
  });

  describe('hasFileExtension', () => {
    it('should recognise a dot followed by letters at the end', () => {
      expect(hasFileExtension('./a.ts')).toBe(true);
      expect(hasFileExtension('./a.JSON')).toBe(true);
      expect(hasFileExtension('./dir.v2/a.css')).toBe(true);
    });

    it('should not recognise anything else', () => {
      expect(hasFileExtension('./a')).toBe(false);
      expect(hasFileExtension('./a.')).toBe(false);
      expect(hasFileExtension('./a.v2')).toBe(false);
      expect(hasFileExtension('./dir.ts/a')).toBe(false);
      expect(hasFileExtension('ts')).toBe(false);
      expect(hasFileExtension('')).toBe(false);
    });
  });

  describe('removeStackLocations', () => {
    it('should remove stack locations', () => {
      expect(removeStackLocations('failed at parse (file.js:1:2) here')).toBe('failed  here');
      expect(removeStackLocations('at a (b)\nat c (d)')).toBe('\n');
    });

    it('should keep text that is not a stack location', () => {
      for (const text of ['Unexpected token (1:5)', 'at the end', 'look at this ()', 'at x (unclosed', '']) {
        expect(removeStackLocations(text)).toBe(text);
      }
    });
  });

  describe('error message of a failed transform', () => {
    afterAll(() => {
      resetBabelContext();
    });

    const babel = createRestrictedBabel({
      maxInputSize: 1024 * 1024,
      maxOutputSize: 5 * 1024 * 1024,
      allowedPresets: ['typescript', 'react'],
      transformTimeout: 15000,
    });
    const messageOf = (code: string): string => {
      try {
        babel.transform(code, { filename: 'a.js' });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('the transform did not fail');
    };

    it('should say what is wrong and where', () => {
      const message = messageOf('const a = ;');

      expect(message).toMatch(/^Babel transform failed: /);
      expect(message).toContain('Unexpected token (1:10)');
    });

    it('should cut a long message and mark the cut', () => {
      const message = messageOf('const a = ;' + ' '.repeat(10_000));

      expect(message).toContain('Unexpected token (1:10)');
      expect(message.endsWith('...')).toBe(true);
      expect(message.length).toBeLessThanOrEqual('Babel transform failed: '.length + 2000 + 3);
    });

    it('should not keep the source of a failed transform for the next call', () => {
      expect(() => babel.transform('const a = ;')).toThrow(/Babel transform failed/);

      expect(babel.transform('const b = 1;').code).toContain('const b = 1;');
    });
  });
});
