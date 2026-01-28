/**
 * Babel Transform Examples Tests
 *
 * Unit tests validating all 50 TSX/JSX examples transform correctly.
 *
 * @packageDocumentation
 */

import { createRestrictedBabel, resetBabelContext, BabelWrapperConfig } from '../babel';
import {
  BABEL_EXAMPLES,
  COMPLEXITY_LEVELS,
  getExamplesByLevel,
  getLevelStats,
  ComplexityLevel,
  ComponentExample,
} from './babel-examples';

describe('Babel Transform Examples', () => {
  const defaultConfig: BabelWrapperConfig = {
    maxInputSize: 1024 * 1024, // 1MB
    maxOutputSize: 5 * 1024 * 1024, // 5MB
    allowedPresets: ['typescript', 'react'],
    transformTimeout: 15000,
  };

  let babel: ReturnType<typeof createRestrictedBabel>;

  beforeAll(() => {
    babel = createRestrictedBabel(defaultConfig);
  });

  afterAll(() => {
    resetBabelContext();
  });

  describe('Example Coverage', () => {
    it('should have exactly 50 examples', () => {
      expect(BABEL_EXAMPLES.length).toBe(50);
    });

    it('should have 10 examples per complexity level', () => {
      const stats = getLevelStats();

      for (const level of COMPLEXITY_LEVELS) {
        expect(stats[level].count).toBe(10);
      }
    });

    it('should have unique IDs for all examples', () => {
      const ids = BABEL_EXAMPLES.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(BABEL_EXAMPLES.length);
    });

    it('should have IDs from 1 to 50', () => {
      const ids = BABEL_EXAMPLES.map((e) => e.id).sort((a, b) => a - b);
      expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    });

    it('should have unique names for all examples', () => {
      const names = BABEL_EXAMPLES.map((e) => e.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(BABEL_EXAMPLES.length);
    });
  });

  describe.each(COMPLEXITY_LEVELS)('Level: %s', (level: ComplexityLevel) => {
    const examples = getExamplesByLevel(level);

    describe('Transform validation', () => {
      it.each(examples.map((e) => [e.name, e] as const))(
        '%s - transforms without errors',
        (_name: string, example: ComponentExample) => {
          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          expect(result).toBeDefined();
          expect(result.code).toBeDefined();
          expect(typeof result.code).toBe('string');
          expect(result.code.length).toBeGreaterThan(0);
        },
      );

      it.each(examples.map((e) => [e.name, e] as const))(
        '%s - contains expected patterns',
        (_name: string, example: ComponentExample) => {
          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          for (const pattern of example.expectedPatterns) {
            expect(result.code).toContain(pattern);
          }
        },
      );

      it.each(examples.map((e) => [e.name, e] as const))(
        '%s - does not contain forbidden patterns',
        (_name: string, example: ComponentExample) => {
          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          for (const pattern of example.forbiddenPatterns ?? []) {
            expect(result.code).not.toContain(pattern);
          }
        },
      );
    });
  });

  describe('TypeScript Type Stripping', () => {
    const examplesWithTypes = BABEL_EXAMPLES.filter((e) => e.forbiddenPatterns && e.forbiddenPatterns.length > 0);

    it('should have examples with TypeScript types to strip', () => {
      expect(examplesWithTypes.length).toBeGreaterThan(0);
    });

    it.each(examplesWithTypes.map((e) => [e.name, e] as const))(
      '%s - strips all TypeScript types',
      (_name: string, example: ComponentExample) => {
        const result = babel.transform(example.code, {
          presets: ['typescript', 'react'],
          filename: `${example.name}.tsx`,
        });

        // Verify no TypeScript-specific syntax remains
        expect(result.code).not.toMatch(/\binterface\s+\w+/);
        expect(result.code).not.toMatch(/\btype\s+\w+\s*=/);
        expect(result.code).not.toMatch(/:\s*\w+\[\]/);
        expect(result.code).not.toMatch(/<\w+>/); // Generic brackets (when not JSX)
      },
    );
  });

  describe('JSX Transformation', () => {
    it('should transform JSX to React.createElement calls', () => {
      for (const example of BABEL_EXAMPLES) {
        // Use explicit classic runtime to ensure React.createElement output
        const result = babel.transform(example.code, {
          presets: ['typescript', 'react'] as string[],
          filename: `${example.name}.tsx`,
        });

        // All examples should produce React.createElement calls (classic runtime)
        expect(result.code).toContain('React.createElement');
      }
    });

    it('should not contain JSX syntax in output', () => {
      for (const example of BABEL_EXAMPLES) {
        const result = babel.transform(example.code, {
          presets: ['typescript', 'react'] as string[],
          filename: `${example.name}.tsx`,
        });

        // No JSX opening/closing tags should remain
        expect(result.code).not.toMatch(/<[A-Z][a-zA-Z]*[^>]*>/);
        expect(result.code).not.toMatch(/<\/[A-Z][a-zA-Z]*>/);
        expect(result.code).not.toMatch(/<[a-z]+[^>]*>/);
        expect(result.code).not.toMatch(/<\/[a-z]+>/);
        // Fragment syntax
        expect(result.code).not.toMatch(/<>/);
        expect(result.code).not.toMatch(/<\/>/);
      }
    });
  });

  describe('Output Validation', () => {
    it('should produce valid JavaScript for all examples', () => {
      for (const example of BABEL_EXAMPLES) {
        const result = babel.transform(example.code, {
          presets: ['typescript', 'react'],
          filename: `${example.name}.tsx`,
        });

        // Attempting to parse the output should not throw
        expect(() => {
          // Basic syntax check - if this throws, the output is invalid JS
          new Function(result.code);
        }).not.toThrow();
      }
    });

    it('should produce non-empty code for all examples', () => {
      for (const example of BABEL_EXAMPLES) {
        const result = babel.transform(example.code, {
          presets: ['typescript', 'react'],
          filename: `${example.name}.tsx`,
        });

        // All examples should produce non-trivial output
        expect(result.code.length).toBeGreaterThan(50);
        // Should contain at least one const or function declaration
        expect(result.code).toMatch(/\b(const|function|class)\s+\w+/);
      }
    });
  });

  describe('Complexity Level Characteristics', () => {
    describe('L1_MINIMAL', () => {
      const l1Examples = getExamplesByLevel('L1_MINIMAL');

      it('should have simple, single-element components', () => {
        for (const example of l1Examples) {
          // L1 examples should be relatively short
          expect(example.code.length).toBeLessThan(500);

          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          // Output should also be concise
          expect(result.code.length).toBeLessThan(1000);
        }
      });
    });

    describe('L2_SIMPLE', () => {
      const l2Examples = getExamplesByLevel('L2_SIMPLE');

      it('should have function components with parameters', () => {
        for (const example of l2Examples) {
          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          // L2 examples should contain React.createElement and function definitions
          expect(result.code).toContain('React.createElement');
          // Should have either a const arrow function or function declaration
          expect(result.code).toMatch(/const\s+\w+\s*=|function\s+\w+/);
        }
      });
    });

    describe('L3_STYLED', () => {
      const l3Examples = getExamplesByLevel('L3_STYLED');

      it('should have style-related code', () => {
        for (const example of l3Examples) {
          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          // L3 examples should have style or className
          const hasStyles =
            result.code.includes('style:') || result.code.includes('className:') || result.code.includes('styles.');
          expect(hasStyles).toBe(true);
        }
      });
    });

    describe('L4_COMPOSITE', () => {
      const l4Examples = getExamplesByLevel('L4_COMPOSITE');

      it('should have multiple component definitions or complex patterns', () => {
        for (const example of l4Examples) {
          // L4 examples should have more code
          expect(example.code.length).toBeGreaterThan(200);

          const result = babel.transform(example.code, {
            presets: ['typescript', 'react'],
            filename: `${example.name}.tsx`,
          });

          // Multiple React.createElement calls expected
          const createElementCount = (result.code.match(/React\.createElement/g) || []).length;
          expect(createElementCount).toBeGreaterThan(1);
        }
      });
    });

    describe('L5_COMPLEX', () => {
      const l5Examples = getExamplesByLevel('L5_COMPLEX');

      it('should have TypeScript types to strip', () => {
        for (const example of l5Examples) {
          // All L5 examples should have forbidden patterns (types)
          expect(example.forbiddenPatterns).toBeDefined();
          expect(example.forbiddenPatterns!.length).toBeGreaterThan(0);
        }
      });

      it('should be the most complex examples', () => {
        const l5Stats = getLevelStats()['L5_COMPLEX'];
        const l1Stats = getLevelStats()['L1_MINIMAL'];

        // L5 average size should be significantly larger than L1
        expect(l5Stats.avgSize).toBeGreaterThan(l1Stats.avgSize * 3);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty fragment', () => {
      const result = babel.transform('const Empty = () => <></>;', {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).toContain('React.Fragment');
    });

    it('should handle deeply nested JSX', () => {
      const deeplyNested = `
        const Deep = () => (
          <div>
            <div>
              <div>
                <div>
                  <div>
                    <span>Deep</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      `;
      const result = babel.transform(deeplyNested, {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      const createElementCount = (result.code.match(/React\.createElement/g) || []).length;
      expect(createElementCount).toBe(6);
    });

    it('should handle mixed expressions and elements', () => {
      const mixed = `
        const Mixed = ({ items }: { items: string[] }) => (
          <ul>
            {items.length === 0 && <li>No items</li>}
            {items.length > 0 && items.map((item, i) => <li key={i}>{item}</li>)}
            {items.length > 10 && <li>...and more</li>}
          </ul>
        );
      `;
      const result = babel.transform(mixed, {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).not.toContain('interface');
      expect(result.code).not.toContain(': string[]');
    });

    it('should handle class components with lifecycle methods', () => {
      const classComponent = `
        class LifecycleComponent extends React.Component<{ name: string }, { mounted: boolean }> {
          state = { mounted: false };
          componentDidMount() { this.setState({ mounted: true }); }
          componentWillUnmount() { console.log('unmounting'); }
          render() {
            return <div>{this.state.mounted ? 'Mounted' : 'Not mounted'}</div>;
          }
        }
      `;
      const result = babel.transform(classComponent, {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).toContain('componentDidMount');
      expect(result.code).toContain('componentWillUnmount');
      expect(result.code).not.toContain('<{ name: string }');
    });

    it('should handle JSX spread attributes', () => {
      const spread = `
        const Spread = (props: { id: string; className: string }) => {
          const extra = { 'data-test': 'value', role: 'button' };
          return <div {...props} {...extra}>Content</div>;
        };
      `;
      const result = babel.transform(spread, {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).not.toContain(': { id: string');
    });

    it('should handle template literals in className', () => {
      const template = `
        const Template = ({ active }: { active: boolean }) => (
          <div className={\`base \${active ? 'active' : 'inactive'} suffix\`}>Content</div>
        );
      `;
      const result = babel.transform(template, {
        presets: ['typescript', 'react'],
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).toContain('active');
      expect(result.code).not.toContain(': { active: boolean }');
    });
  });

  describe('React-only transforms (no TypeScript)', () => {
    it('should transform pure JSX without TypeScript preset', () => {
      const jsx = 'const Pure = () => <div>Pure JSX</div>;';
      const result = babel.transform(jsx, {
        presets: ['react'],
        filename: 'Pure.jsx',
      });
      expect(result.code).toContain('React.createElement');
      expect(result.code).toContain('"div"');
    });

    it('should fail on TypeScript syntax with only react preset', () => {
      const tsx = 'const Typed = ({ name }: { name: string }) => <div>{name}</div>;';
      expect(() => {
        babel.transform(tsx, {
          presets: ['react'],
          filename: 'Typed.jsx',
        });
      }).toThrow();
    });
  });
});
