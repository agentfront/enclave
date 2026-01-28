/**
 * Babel Transform Test Examples
 *
 * 50 TSX/JSX component examples ranging from minimal to complex.
 * Used for testing the Babel preset transform capability.
 *
 * @packageDocumentation
 */

/**
 * Complexity levels for component examples
 */
export type ComplexityLevel = 'L1_MINIMAL' | 'L2_SIMPLE' | 'L3_STYLED' | 'L4_COMPOSITE' | 'L5_COMPLEX';

/**
 * Array of all complexity levels for iteration
 */
export const COMPLEXITY_LEVELS: ComplexityLevel[] = [
  'L1_MINIMAL',
  'L2_SIMPLE',
  'L3_STYLED',
  'L4_COMPOSITE',
  'L5_COMPLEX',
];

/**
 * Component example for testing Babel transforms
 */
export interface ComponentExample {
  /** Unique identifier (1-50) */
  id: number;
  /** Component name */
  name: string;
  /** Complexity level */
  level: ComplexityLevel;
  /** Human-readable description */
  description: string;
  /** Source TSX/JSX code */
  code: string;
  /** Patterns that MUST appear in transformed output */
  expectedPatterns: string[];
  /** Patterns that must NOT appear in output (e.g., TypeScript types) */
  forbiddenPatterns?: string[];
}

/**
 * 50 TSX/JSX component examples organized by complexity level
 */
export const BABEL_EXAMPLES: ComponentExample[] = [
  // ==========================================================================
  // L1: MINIMAL (1-10) - Single elements, no props, basic JSX
  // ==========================================================================
  {
    id: 1,
    name: 'PlainText',
    level: 'L1_MINIMAL',
    description: 'Plain text element',
    code: `const PlainText = () => <div>Hello World</div>;`,
    expectedPatterns: ['React.createElement', '"div"', '"Hello World"'],
  },
  {
    id: 2,
    name: 'SelfClosing',
    level: 'L1_MINIMAL',
    description: 'Self-closing element',
    code: `const SelfClosing = () => <input type="text" />;`,
    expectedPatterns: ['React.createElement', '"input"', 'type:', '"text"'],
  },
  {
    id: 3,
    name: 'WithExpression',
    level: 'L1_MINIMAL',
    description: 'Element with expression',
    code: `const WithExpression = () => <span>{1 + 1}</span>;`,
    expectedPatterns: ['React.createElement', '"span"', '1 + 1'],
  },
  {
    id: 4,
    name: 'WithFragment',
    level: 'L1_MINIMAL',
    description: 'Fragment with children',
    code: `const WithFragment = () => <><span>A</span><span>B</span></>;`,
    expectedPatterns: ['React.createElement', 'React.Fragment', '"span"'],
  },
  {
    id: 5,
    name: 'Siblings',
    level: 'L1_MINIMAL',
    description: 'Multiple sibling elements',
    code: `const Siblings = () => <div><span>One</span><span>Two</span></div>;`,
    expectedPatterns: ['React.createElement', '"div"', '"span"', '"One"', '"Two"'],
  },
  {
    id: 6,
    name: 'NestedElements',
    level: 'L1_MINIMAL',
    description: 'Deeply nested elements',
    code: `const NestedElements = () => <div><section><article><p>Deep</p></article></section></div>;`,
    expectedPatterns: ['React.createElement', '"div"', '"section"', '"article"', '"p"', '"Deep"'],
  },
  {
    id: 7,
    name: 'WithClassName',
    level: 'L1_MINIMAL',
    description: 'Element with className',
    code: `const WithClassName = () => <div className="container">Content</div>;`,
    expectedPatterns: ['React.createElement', '"div"', 'className:', '"container"'],
  },
  {
    id: 8,
    name: 'WithDataAttribute',
    level: 'L1_MINIMAL',
    description: 'Element with data attribute',
    code: `const WithDataAttribute = () => <div data-testid="my-element">Test</div>;`,
    expectedPatterns: ['React.createElement', '"div"', 'data-testid', '"my-element"'],
  },
  {
    id: 9,
    name: 'WithSpreadProps',
    level: 'L1_MINIMAL',
    description: 'Element with spread props',
    code: `const props = { id: 'main', role: 'main' };
const WithSpreadProps = () => <div {...props}>Spread</div>;`,
    expectedPatterns: ['React.createElement', '"div"', 'props'],
  },
  {
    id: 10,
    name: 'ArrowComponent',
    level: 'L1_MINIMAL',
    description: 'Arrow function component',
    code: `const ArrowComponent = () => <button>Click</button>;`,
    expectedPatterns: ['React.createElement', '"button"', '"Click"'],
  },

  // ==========================================================================
  // L2: SIMPLE (11-20) - Props, events, basic patterns
  // ==========================================================================
  {
    id: 11,
    name: 'PropsDestructuring',
    level: 'L2_SIMPLE',
    description: 'Props destructuring',
    code: `interface ButtonProps { label: string; onClick: () => void; }
const Button = ({ label, onClick }: ButtonProps) => (
  <button onClick={onClick}>{label}</button>
);`,
    expectedPatterns: ['React.createElement', '"button"', 'onClick', 'label'],
    forbiddenPatterns: ['interface', 'ButtonProps', ': string', ': void'],
  },
  {
    id: 12,
    name: 'ChildrenProp',
    level: 'L2_SIMPLE',
    description: 'Children prop usage',
    code: `interface WrapperProps { children: React.ReactNode; }
const Wrapper = ({ children }: WrapperProps) => (
  <div className="wrapper">{children}</div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'children', '"wrapper"'],
    forbiddenPatterns: ['interface', 'WrapperProps', 'ReactNode'],
  },
  {
    id: 13,
    name: 'EventHandler',
    level: 'L2_SIMPLE',
    description: 'Event handler',
    code: `const EventHandler = () => (
  <button onClick={(e) => console.log('clicked', e.target)}>Click Me</button>
);`,
    expectedPatterns: ['React.createElement', '"button"', 'onClick', 'console.log', 'e.target'],
  },
  {
    id: 14,
    name: 'ConditionalRendering',
    level: 'L2_SIMPLE',
    description: 'Conditional rendering',
    code: `interface ShowProps { show: boolean; }
const Conditional = ({ show }: ShowProps) => (
  <div>{show ? <span>Visible</span> : <span>Hidden</span>}</div>
);`,
    expectedPatterns: ['React.createElement', '"div"', '"span"', 'show', '"Visible"', '"Hidden"'],
    forbiddenPatterns: ['interface', 'ShowProps', ': boolean'],
  },
  {
    id: 15,
    name: 'ArrayMap',
    level: 'L2_SIMPLE',
    description: 'Array map rendering',
    code: `interface ListProps { items: string[]; }
const List = ({ items }: ListProps) => (
  <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
);`,
    expectedPatterns: ['React.createElement', '"ul"', '"li"', 'map', 'key:'],
    forbiddenPatterns: ['interface', 'ListProps', 'string[]'],
  },
  {
    id: 16,
    name: 'OptionalChaining',
    level: 'L2_SIMPLE',
    description: 'Optional chaining in JSX',
    code: `interface UserProps { user?: { name: string; }; }
const UserName = ({ user }: UserProps) => (
  <span>{user?.name ?? 'Anonymous'}</span>
);`,
    expectedPatterns: ['React.createElement', '"span"', 'user', 'Anonymous'],
    forbiddenPatterns: ['interface', 'UserProps'],
  },
  {
    id: 17,
    name: 'DefaultProps',
    level: 'L2_SIMPLE',
    description: 'Default props pattern',
    code: `interface GreetingProps { name?: string; }
const Greeting = ({ name = 'World' }: GreetingProps) => (
  <h1>Hello, {name}!</h1>
);`,
    expectedPatterns: ['React.createElement', '"h1"', 'World', 'name'],
    forbiddenPatterns: ['interface', 'GreetingProps'],
  },
  {
    id: 18,
    name: 'ChildrenArray',
    level: 'L2_SIMPLE',
    description: 'Rendering children array',
    code: `const items = [<span key="a">A</span>, <span key="b">B</span>];
const ChildrenArray = () => <div>{items}</div>;`,
    expectedPatterns: ['React.createElement', '"div"', '"span"', 'items'],
  },
  {
    id: 19,
    name: 'KeyPropList',
    level: 'L2_SIMPLE',
    description: 'Key prop in list',
    code: `interface DataItem { id: string; text: string; }
interface DataListProps { items: DataItem[]; }
const DataList = ({ items }: DataListProps) => (
  <ul>{items.map(item => <li key={item.id}>{item.text}</li>)}</ul>
);`,
    expectedPatterns: ['React.createElement', '"ul"', '"li"', 'key:', 'item.id', 'item.text'],
    forbiddenPatterns: ['interface DataItem', 'interface DataListProps', 'DataItem[]'],
  },
  {
    id: 20,
    name: 'ComponentComposition',
    level: 'L2_SIMPLE',
    description: 'Component composition',
    code: `const Header = () => <header><h1>Title</h1></header>;
const Footer = () => <footer><p>Footer</p></footer>;
const Page = () => <div><Header /><main>Content</main><Footer /></div>;`,
    expectedPatterns: ['React.createElement', 'Header', 'Footer', '"header"', '"footer"', '"main"'],
  },

  // ==========================================================================
  // L3: STYLED (21-30) - Inline styles, dynamic styling, CSS patterns
  // ==========================================================================
  {
    id: 21,
    name: 'InlineStyle',
    level: 'L3_STYLED',
    description: 'Inline style object',
    code: `const StyledBox = () => (
  <div style={{ padding: '16px', backgroundColor: '#f0f0f0', borderRadius: '8px' }}>
    Styled content
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'style:', 'padding:', 'backgroundColor:', 'borderRadius:'],
  },
  {
    id: 22,
    name: 'DynamicStyles',
    level: 'L3_STYLED',
    description: 'Dynamic styles based on props',
    code: `interface BoxProps { size: 'sm' | 'md' | 'lg'; }
const DynamicBox = ({ size }: BoxProps) => {
  const sizes = { sm: 8, md: 16, lg: 24 };
  return <div style={{ padding: sizes[size] }}>Content</div>;
};`,
    expectedPatterns: ['React.createElement', '"div"', 'style:', 'sizes', 'size'],
    forbiddenPatterns: ['interface', 'BoxProps', "'sm' | 'md' | 'lg'"],
  },
  {
    id: 23,
    name: 'ConditionalClassName',
    level: 'L3_STYLED',
    description: 'Conditional className',
    code: `interface AlertProps { type: 'success' | 'error' | 'warning'; message: string; }
const Alert = ({ type, message }: AlertProps) => (
  <div className={\`alert alert-\${type}\`}>{message}</div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'className:', 'alert', 'type'],
    forbiddenPatterns: ['interface', 'AlertProps'],
  },
  {
    id: 24,
    name: 'CSSModulesPattern',
    level: 'L3_STYLED',
    description: 'CSS modules pattern',
    code: `const styles = { container: 'container_abc123', title: 'title_def456' };
const CSSModules = () => (
  <div className={styles.container}>
    <h1 className={styles.title}>Styled Title</h1>
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', '"h1"', 'styles.container', 'styles.title'],
  },
  {
    id: 25,
    name: 'StyleVariables',
    level: 'L3_STYLED',
    description: 'CSS variables in style',
    code: `interface ThemeProps { primaryColor: string; }
const ThemedButton = ({ primaryColor }: ThemeProps) => (
  <button style={{ '--primary': primaryColor, backgroundColor: 'var(--primary)' } as React.CSSProperties}>
    Themed
  </button>
);`,
    expectedPatterns: ['React.createElement', '"button"', 'style:', '--primary', 'primaryColor'],
    forbiddenPatterns: ['interface', 'ThemeProps', 'CSSProperties'],
  },
  {
    id: 26,
    name: 'ResponsiveStyles',
    level: 'L3_STYLED',
    description: 'Responsive style helper',
    code: `interface CardProps { compact?: boolean; }
const ResponsiveCard = ({ compact = false }: CardProps) => (
  <div style={{
    padding: compact ? '8px' : '24px',
    maxWidth: compact ? '300px' : '600px',
    margin: '0 auto'
  }}>
    Card Content
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'style:', 'compact', 'padding:', 'maxWidth:'],
    forbiddenPatterns: ['interface', 'CardProps'],
  },
  {
    id: 27,
    name: 'ThemeAwareStyles',
    level: 'L3_STYLED',
    description: 'Theme-aware styles',
    code: `interface ColorPalette { colors: { primary: string; secondary: string; }; }
interface ColorBoxProps { palette: ColorPalette; }
const ThemeAwareBox = ({ palette }: ColorBoxProps) => (
  <div style={{ backgroundColor: palette.colors.primary, color: palette.colors.secondary }}>
    Themed Box
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'palette.colors.primary', 'palette.colors.secondary'],
    forbiddenPatterns: ['interface ColorPalette', 'interface ColorBoxProps'],
  },
  {
    id: 28,
    name: 'AnimationStyles',
    level: 'L3_STYLED',
    description: 'Animation styles',
    code: `interface AnimatedProps { isVisible: boolean; }
const AnimatedBox = ({ isVisible }: AnimatedProps) => (
  <div style={{
    opacity: isVisible ? 1 : 0,
    transform: isVisible ? 'translateY(0)' : 'translateY(-20px)',
    transition: 'all 0.3s ease-in-out'
  }}>
    Animated Content
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', 'opacity:', 'transform:', 'transition:', 'isVisible'],
    forbiddenPatterns: ['interface', 'AnimatedProps'],
  },
  {
    id: 29,
    name: 'PseudoClassPatterns',
    level: 'L3_STYLED',
    description: 'Hover state pattern (inline)',
    code: `const HoverButton = () => {
  const [isHovered, setIsHovered] = [false, (v: boolean) => {}];
  return (
    <button
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ backgroundColor: isHovered ? '#0056b3' : '#007bff', color: 'white' }}
    >
      Hover Me
    </button>
  );
};`,
    expectedPatterns: ['React.createElement', '"button"', 'onMouseEnter', 'onMouseLeave', 'isHovered'],
  },
  {
    id: 30,
    name: 'MediaQueryStyles',
    level: 'L3_STYLED',
    description: 'Media query responsive pattern',
    code: `interface ResponsiveProps { isMobile: boolean; }
const ResponsiveLayout = ({ isMobile }: ResponsiveProps) => (
  <div style={{
    display: 'flex',
    flexDirection: isMobile ? 'column' : 'row',
    gap: isMobile ? '8px' : '16px'
  }}>
    <aside style={{ width: isMobile ? '100%' : '250px' }}>Sidebar</aside>
    <main style={{ flex: 1 }}>Main Content</main>
  </div>
);`,
    expectedPatterns: ['React.createElement', '"div"', '"aside"', '"main"', 'flexDirection', 'isMobile'],
    forbiddenPatterns: ['interface', 'ResponsiveProps'],
  },

  // ==========================================================================
  // L4: COMPOSITE (31-40) - Multi-component patterns, render props, HOCs
  // ==========================================================================
  {
    id: 31,
    name: 'ParentChildProps',
    level: 'L4_COMPOSITE',
    description: 'Parent-child prop passing',
    code: `interface CardProps { title: string; children: React.ReactNode; }
const Card = ({ title, children }: CardProps) => (
  <div className="card">
    <h2 className="card-title">{title}</h2>
    <div className="card-body">{children}</div>
  </div>
);

const CardExample = () => (
  <Card title="My Card">
    <p>Card content goes here</p>
  </Card>
);`,
    expectedPatterns: ['React.createElement', '"div"', '"h2"', 'title', 'children', 'Card'],
    forbiddenPatterns: ['interface', 'CardProps', 'ReactNode'],
  },
  {
    id: 32,
    name: 'RenderProps',
    level: 'L4_COMPOSITE',
    description: 'Render props pattern',
    code: `interface MouseTrackerProps { render: (x: number, y: number) => React.ReactNode; }
const MouseTracker = ({ render }: MouseTrackerProps) => {
  const position = { x: 0, y: 0 };
  return <div onMouseMove={(e) => {}}>{render(position.x, position.y)}</div>;
};

const TrackerExample = () => (
  <MouseTracker render={(x, y) => <span>Mouse: {x}, {y}</span>} />
);`,
    expectedPatterns: ['React.createElement', 'render', 'position', 'MouseTracker'],
    forbiddenPatterns: ['interface', 'MouseTrackerProps', 'ReactNode'],
  },
  {
    id: 33,
    name: 'CompoundComponents',
    level: 'L4_COMPOSITE',
    description: 'Compound components pattern',
    code: `const TabsContext = { activeTab: 0 };

interface TabProps { index: number; children: React.ReactNode; }
const Tab = ({ index, children }: TabProps) => (
  <div className={TabsContext.activeTab === index ? 'active' : ''}>{children}</div>
);

interface TabsProps { children: React.ReactNode; }
const Tabs = ({ children }: TabsProps) => (
  <div className="tabs">{children}</div>
);

const TabsExample = () => (
  <Tabs>
    <Tab index={0}>Tab 1 Content</Tab>
    <Tab index={1}>Tab 2 Content</Tab>
  </Tabs>
);`,
    expectedPatterns: ['React.createElement', 'Tab', 'Tabs', 'TabsContext', 'activeTab', 'index'],
    forbiddenPatterns: ['interface', 'TabProps', 'TabsProps'],
  },
  {
    id: 34,
    name: 'SlotPattern',
    level: 'L4_COMPOSITE',
    description: 'Slot pattern',
    code: `interface LayoutProps {
  header?: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}
const Layout = ({ header, sidebar, children, footer }: LayoutProps) => (
  <div className="layout">
    {header && <header className="layout-header">{header}</header>}
    <div className="layout-body">
      {sidebar && <aside className="layout-sidebar">{sidebar}</aside>}
      <main className="layout-main">{children}</main>
    </div>
    {footer && <footer className="layout-footer">{footer}</footer>}
  </div>
);`,
    expectedPatterns: ['React.createElement', 'header', 'sidebar', 'children', 'footer', '"layout"'],
    forbiddenPatterns: ['interface', 'LayoutProps', 'ReactNode'],
  },
  {
    id: 35,
    name: 'HOCPattern',
    level: 'L4_COMPOSITE',
    description: 'Higher-order component pattern',
    code: `interface WithLoadingProps { isLoading: boolean; }
function withLoading<P extends object>(Component: React.ComponentType<P>) {
  return ({ isLoading, ...props }: P & WithLoadingProps) => {
    if (isLoading) return <div className="loading">Loading...</div>;
    return <Component {...props as P} />;
  };
}

interface DataProps { data: string; }
const DataDisplay = ({ data }: DataProps) => <div>{data}</div>;
const DataDisplayWithLoading = withLoading(DataDisplay);`,
    expectedPatterns: ['React.createElement', 'isLoading', 'Loading', 'Component', 'withLoading'],
    forbiddenPatterns: ['interface', 'WithLoadingProps', 'DataProps', 'ComponentType'],
  },
  {
    id: 36,
    name: 'ContextConsumer',
    level: 'L4_COMPOSITE',
    description: 'Context consumer pattern',
    code: `interface ThemeContextType { theme: 'light' | 'dark'; toggleTheme: () => void; }
const ThemeContext = { theme: 'light' as const, toggleTheme: () => {} };

const ThemedComponent = () => {
  const { theme, toggleTheme } = ThemeContext;
  return (
    <div className={\`themed themed-\${theme}\`}>
      <button onClick={toggleTheme}>Toggle Theme</button>
      <p>Current theme: {theme}</p>
    </div>
  );
};`,
    expectedPatterns: ['React.createElement', 'theme', 'toggleTheme', 'ThemeContext'],
    forbiddenPatterns: ['interface', 'ThemeContextType'],
  },
  {
    id: 37,
    name: 'ForwardRefPattern',
    level: 'L4_COMPOSITE',
    description: 'Forward ref pattern',
    code: `interface InputProps {
  label: string;
  placeholder?: string;
}

const ForwardedInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, placeholder }, ref) => (
    <div className="form-field">
      <label>{label}</label>
      <input ref={ref} placeholder={placeholder} />
    </div>
  )
);

const InputExample = () => {
  const inputRef = { current: null };
  return <ForwardedInput ref={inputRef} label="Name" placeholder="Enter name" />;
};`,
    expectedPatterns: ['React.createElement', 'forwardRef', 'ref', 'label', 'placeholder'],
    forbiddenPatterns: ['interface', 'InputProps', 'HTMLInputElement'],
  },
  {
    id: 38,
    name: 'ControlledComponent',
    level: 'L4_COMPOSITE',
    description: 'Controlled component pattern',
    code: `interface ControlledInputProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
}

const ControlledInput = ({ value, onChange, label }: ControlledInputProps) => (
  <div className="controlled-field">
    <label>{label}</label>
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
    <span className="char-count">{value.length} characters</span>
  </div>
);`,
    expectedPatterns: ['React.createElement', 'value', 'onChange', 'e.target.value', 'value.length'],
    forbiddenPatterns: ['interface', 'ControlledInputProps'],
  },
  {
    id: 39,
    name: 'FormWithFields',
    level: 'L4_COMPOSITE',
    description: 'Form with multiple fields',
    code: `interface ContactFormProps { onSubmit: (data: FormData) => void; }
const ContactForm = ({ onSubmit }: ContactFormProps) => (
  <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.target as HTMLFormElement)); }}>
    <div className="form-group">
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" placeholder="your@email.com" required />
    </div>
    <div className="form-group">
      <label htmlFor="subject">Subject</label>
      <input id="subject" name="subject" type="text" placeholder="Subject" />
    </div>
    <div className="form-group">
      <label htmlFor="message">Message</label>
      <textarea id="message" name="message" placeholder="Your message..." rows={5} />
    </div>
    <button type="submit">Send Message</button>
  </form>
);`,
    expectedPatterns: ['React.createElement', '"form"', 'onSubmit', '"email"', '"textarea"', '"submit"'],
    forbiddenPatterns: ['interface', 'ContactFormProps', 'HTMLFormElement'],
  },
  {
    id: 40,
    name: 'ListWithItems',
    level: 'L4_COMPOSITE',
    description: 'List with item components',
    code: `interface TaskEntry { id: string; text: string; completed: boolean; }
interface TaskEntryProps { entry: TaskEntry; onToggle: (id: string) => void; onDelete: (id: string) => void; }

const TaskEntryComponent = ({ entry, onToggle, onDelete }: TaskEntryProps) => (
  <li className={\`todo-item \${entry.completed ? 'completed' : ''}\`}>
    <input type="checkbox" checked={entry.completed} onChange={() => onToggle(entry.id)} />
    <span className="todo-text">{entry.text}</span>
    <button className="delete-btn" onClick={() => onDelete(entry.id)}>Delete</button>
  </li>
);

interface TaskListProps { entries: TaskEntry[]; onToggle: (id: string) => void; onDelete: (id: string) => void; }
const TaskList = ({ entries, onToggle, onDelete }: TaskListProps) => (
  <ul className="todo-list">
    {entries.map(entry => (
      <TaskEntryComponent key={entry.id} entry={entry} onToggle={onToggle} onDelete={onDelete} />
    ))}
  </ul>
);`,
    expectedPatterns: [
      'React.createElement',
      '"li"',
      '"ul"',
      'TaskEntryComponent',
      'entry.completed',
      'onToggle',
      'onDelete',
    ],
    forbiddenPatterns: ['interface TaskEntry', 'interface TaskEntryProps', 'interface TaskListProps'],
  },

  // ==========================================================================
  // L5: COMPLEX (41-50) - Full TypeScript, generics, advanced patterns
  // ==========================================================================
  {
    id: 41,
    name: 'FullTypescriptTypes',
    level: 'L5_COMPLEX',
    description: 'Full TypeScript types component',
    code: `interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: 'admin' | 'user' | 'guest';
}

interface UserCardProps {
  user: User;
  onEdit?: (user: User) => void;
  onDelete?: (id: string) => void;
  variant?: 'compact' | 'full';
  showActions?: boolean;
}

const UserCard = ({ user, onEdit, onDelete, variant = 'compact', showActions = true }: UserCardProps) => (
  <div className={\`user-card user-card--\${variant}\`}>
    {user.avatar && <img src={user.avatar} alt={user.name} className="user-avatar" />}
    <div className="user-info">
      <h3 className="user-name">{user.name}</h3>
      <p className="user-email">{user.email}</p>
      <span className={\`user-role role--\${user.role}\`}>{user.role}</span>
    </div>
    {showActions && (
      <div className="user-actions">
        {onEdit && <button onClick={() => onEdit(user)}>Edit</button>}
        {onDelete && <button onClick={() => onDelete(user.id)}>Delete</button>}
      </div>
    )}
  </div>
);`,
    expectedPatterns: [
      'React.createElement',
      'user.avatar',
      'user.name',
      'user.email',
      'user.role',
      'onEdit',
      'onDelete',
    ],
    forbiddenPatterns: ['interface User', 'interface UserCardProps', ': string;', ': boolean;'],
  },
  {
    id: 42,
    name: 'GenericComponent',
    level: 'L5_COMPLEX',
    description: 'Generic component',
    code: `interface SelectOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T> {
  options: SelectOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
}

function Select<T extends string | number>({ options, value, onChange, placeholder, disabled }: SelectProps<T>) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as T)}
      disabled={disabled}
      className="select-input"
    >
      {placeholder && <option value="" disabled>{placeholder}</option>}
      {options.map((opt) => (
        <option key={String(opt.value)} value={String(opt.value)} disabled={opt.disabled}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}`,
    expectedPatterns: ['React.createElement', '"select"', '"option"', 'options', 'value', 'onChange', 'placeholder'],
    forbiddenPatterns: ['interface', 'SelectOption', 'SelectProps', '<T>', 'extends'],
  },
  {
    id: 43,
    name: 'DiscriminatedUnionProps',
    level: 'L5_COMPLEX',
    description: 'Discriminated union props',
    code: `type ButtonVariant =
  | { variant: 'primary'; emphasized?: boolean }
  | { variant: 'secondary'; outline?: boolean }
  | { variant: 'danger'; confirm?: boolean };

type UnionButtonProps = ButtonVariant & {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
};

const UnionButton = (props: UnionButtonProps) => {
  const { variant, children, onClick, disabled } = props;
  const getClassName = () => {
    let cls = \`btn btn--\${variant}\`;
    if (props.variant === 'primary' && props.emphasized) cls += ' btn--emphasized';
    if (props.variant === 'secondary' && props.outline) cls += ' btn--outline';
    if (props.variant === 'danger' && props.confirm) cls += ' btn--confirm';
    return cls;
  };
  return (
    <button className={getClassName()} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
};`,
    expectedPatterns: ['React.createElement', '"button"', 'variant', 'onClick', 'disabled', 'getClassName'],
    forbiddenPatterns: ['type ButtonVariant', 'UnionButtonProps', 'ReactNode'],
  },
  {
    id: 44,
    name: 'MultipleInterfaces',
    level: 'L5_COMPLEX',
    description: 'Multiple interface composition',
    code: `interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Timestamped {
  timestamp: number;
}

interface WithAuthor {
  author: { id: string; name: string; };
}

interface Comment extends BaseEntity, Timestamped, WithAuthor {
  content: string;
  likes: number;
  replies: Comment[];
}

interface CommentCardProps {
  comment: Comment;
  onLike: (id: string) => void;
  onReply: (id: string, content: string) => void;
  depth?: number;
}

const CommentCard = ({ comment, onLike, onReply, depth = 0 }: CommentCardProps) => (
  <div className="comment" style={{ marginLeft: depth * 20 }}>
    <div className="comment-header">
      <span className="comment-author">{comment.author.name}</span>
      <span className="comment-time">{new Date(comment.timestamp).toLocaleString()}</span>
    </div>
    <p className="comment-content">{comment.content}</p>
    <div className="comment-actions">
      <button onClick={() => onLike(comment.id)}>Like ({comment.likes})</button>
      <button onClick={() => onReply(comment.id, '')}>Reply</button>
    </div>
    {comment.replies.length > 0 && (
      <div className="comment-replies">
        {comment.replies.map(reply => (
          <CommentCard key={reply.id} comment={reply} onLike={onLike} onReply={onReply} depth={depth + 1} />
        ))}
      </div>
    )}
  </div>
);`,
    expectedPatterns: [
      'React.createElement',
      'comment.author.name',
      'comment.content',
      'comment.likes',
      'comment.replies',
      'CommentCard',
    ],
    forbiddenPatterns: [
      'interface BaseEntity',
      'interface Timestamped',
      'interface WithAuthor',
      'interface Comment extends',
      'interface CommentCardProps',
    ],
  },
  {
    id: 45,
    name: 'ClassComponent',
    level: 'L5_COMPLEX',
    description: 'Class component (legacy pattern)',
    code: `interface CounterProps {
  initialValue?: number;
  step?: number;
  max?: number;
  min?: number;
  onChange?: (value: number) => void;
}

interface CounterState {
  count: number;
}

class Counter extends React.Component<CounterProps, CounterState> {
  static defaultProps = { initialValue: 0, step: 1, min: 0, max: 100 };

  state: CounterState = { count: this.props.initialValue ?? 0 };

  increment = () => {
    const { step = 1, max = 100, onChange } = this.props;
    this.setState(prev => {
      const newCount = Math.min(prev.count + step, max);
      onChange?.(newCount);
      return { count: newCount };
    });
  };

  decrement = () => {
    const { step = 1, min = 0, onChange } = this.props;
    this.setState(prev => {
      const newCount = Math.max(prev.count - step, min);
      onChange?.(newCount);
      return { count: newCount };
    });
  };

  render() {
    const { min = 0, max = 100 } = this.props;
    const { count } = this.state;
    return (
      <div className="counter">
        <button onClick={this.decrement} disabled={count <= min}>-</button>
        <span className="counter-value">{count}</span>
        <button onClick={this.increment} disabled={count >= max}>+</button>
      </div>
    );
  }
}`,
    expectedPatterns: ['React.createElement', 'Counter', 'increment', 'decrement', 'count', 'state'],
    forbiddenPatterns: ['interface', 'CounterProps', 'CounterState', '<CounterProps, CounterState>'],
  },
  {
    id: 46,
    name: 'ErrorBoundaryPattern',
    level: 'L5_COMPLEX',
    description: 'Error boundary pattern',
    code: `interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="error-boundary">
          <h2>Something went wrong</h2>
          <details>
            <summary>Error details</summary>
            <pre>{this.state.error?.message}</pre>
          </details>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}`,
    expectedPatterns: [
      'React.createElement',
      'ErrorBoundary',
      'hasError',
      'getDerivedStateFromError',
      'componentDidCatch',
    ],
    forbiddenPatterns: ['interface', 'ErrorBoundaryProps', 'ErrorBoundaryState', 'ErrorInfo'],
  },
  {
    id: 47,
    name: 'AsyncComponentPattern',
    level: 'L5_COMPLEX',
    description: 'Async data loading pattern',
    code: `interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

interface AsyncDataProps<T> {
  asyncFn: () => Promise<T>;
  children: (state: AsyncState<T>) => React.ReactNode;
  deps?: unknown[];
}

function AsyncData<T>({ asyncFn, children, deps = [] }: AsyncDataProps<T>) {
  const state: AsyncState<T> = { data: null, loading: true, error: null };
  // In real code, this would use useEffect and useState
  return <>{children(state)}</>;
}

interface User { id: string; name: string; }

const UserLoader = () => (
  <AsyncData<User> asyncFn={() => Promise.resolve({ id: '1', name: 'John' })}>
    {({ data, loading, error }) => {
      if (loading) return <div className="loading-spinner">Loading user...</div>;
      if (error) return <div className="error-message">Error: {error.message}</div>;
      if (!data) return null;
      return (
        <div className="user-profile">
          <h2>{data.name}</h2>
          <p>ID: {data.id}</p>
        </div>
      );
    }}
  </AsyncData>
);`,
    expectedPatterns: ['React.createElement', 'AsyncData', 'loading', 'error', 'data.name', 'data.id'],
    forbiddenPatterns: ['interface', 'AsyncState', 'AsyncDataProps', '<T>'],
  },
  {
    id: 48,
    name: 'PortalPattern',
    level: 'L5_COMPLEX',
    description: 'Portal pattern for modals',
    code: `interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'small' | 'medium' | 'large';
  closeOnOverlay?: boolean;
}

const Modal = ({ isOpen, onClose, title, children, size = 'medium', closeOnOverlay = true }: ModalProps) => {
  if (!isOpen) return null;
  return (
    <div
      className="modal-overlay"
      onClick={closeOnOverlay ? onClose : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className={\`modal-content modal-content--\${size}\`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">
            &times;
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary">Confirm</button>
        </footer>
      </div>
    </div>
  );
};`,
    expectedPatterns: [
      'React.createElement',
      'isOpen',
      'onClose',
      'title',
      'modal-overlay',
      'modal-content',
      'aria-modal',
    ],
    forbiddenPatterns: ['interface', 'ModalProps', 'ReactNode'],
  },
  {
    id: 49,
    name: 'ComplexForm',
    level: 'L5_COMPLEX',
    description: 'Complex form with validation',
    code: `interface FormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'password' | 'textarea' | 'select';
  required?: boolean;
  options?: { value: string; label: string; }[];
  validation?: (value: string) => string | null;
}

interface DynamicFormProps {
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => void;
  submitLabel?: string;
}

const DynamicForm = ({ fields, onSubmit, submitLabel = 'Submit' }: DynamicFormProps) => {
  const values: Record<string, string> = {};
  const errors: Record<string, string | null> = {};

  const renderField = (field: FormField) => {
    const error = errors[field.name];
    const baseProps = {
      id: field.name,
      name: field.name,
      required: field.required,
      'aria-invalid': !!error,
      'aria-describedby': error ? \`\${field.name}-error\` : undefined,
    };

    return (
      <div key={field.name} className={\`form-field \${error ? 'has-error' : ''}\`}>
        <label htmlFor={field.name}>{field.label}{field.required && <span className="required">*</span>}</label>
        {field.type === 'textarea' ? (
          <textarea {...baseProps} rows={4} />
        ) : field.type === 'select' ? (
          <select {...baseProps}>
            <option value="">Select...</option>
            {field.options?.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        ) : (
          <input {...baseProps} type={field.type} />
        )}
        {error && <span id={\`\${field.name}-error\`} className="field-error">{error}</span>}
      </div>
    );
  };

  return (
    <form className="dynamic-form" onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}>
      {fields.map(renderField)}
      <button type="submit" className="submit-btn">{submitLabel}</button>
    </form>
  );
};`,
    expectedPatterns: [
      'React.createElement',
      'fields',
      'renderField',
      'onSubmit',
      'textarea',
      'select',
      'aria-invalid',
    ],
    forbiddenPatterns: ['interface', 'FormField', 'DynamicFormProps', 'Record<string'],
  },
  {
    id: 50,
    name: 'DashboardLayout',
    level: 'L5_COMPLEX',
    description: 'Dashboard layout with multiple sections',
    code: `interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

interface Stat {
  label: string;
  value: number;
  change: number;
  trend: 'up' | 'down' | 'neutral';
}

interface Notification {
  id: string;
  message: string;
  read: boolean;
  timestamp: number;
  type: 'info' | 'warning' | 'error' | 'success';
}

interface Activity {
  id: string;
  action: string;
  target: string;
  timestamp: number;
}

interface DashboardProps {
  user: User;
  stats: Stat[];
  notifications: Notification[];
  activities: Activity[];
  onNotificationClick: (id: string) => void;
  onActivityClick: (id: string) => void;
}

const Dashboard = ({ user, stats, notifications, activities, onNotificationClick, onActivityClick }: DashboardProps) => (
  <div className="dashboard">
    <header className="dashboard-header">
      <div className="header-left">
        <h1>Dashboard</h1>
        <p className="welcome-message">Welcome back, {user.name}</p>
      </div>
      <div className="header-right">
        <button className="notifications-btn">
          Notifications ({notifications.filter(n => !n.read).length})
        </button>
        <div className="user-menu">
          {user.avatar && <img src={user.avatar} alt="" className="user-avatar" />}
          <span>{user.name}</span>
        </div>
      </div>
    </header>

    <main className="dashboard-main">
      <section className="stats-section">
        <h2>Overview</h2>
        <div className="stats-grid">
          {stats.map((stat, i) => (
            <div key={i} className={\`stat-card stat-card--\${stat.trend}\`}>
              <span className="stat-value">{stat.value.toLocaleString()}</span>
              <span className="stat-label">{stat.label}</span>
              <span className={\`stat-change \${stat.change >= 0 ? 'positive' : 'negative'}\`}>
                {stat.change >= 0 ? '+' : ''}{stat.change}%
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="dashboard-panels">
        <section className="notifications-panel">
          <h2>Notifications</h2>
          <ul className="notifications-list">
            {notifications.slice(0, 5).map(n => (
              <li
                key={n.id}
                className={\`notification notification--\${n.type} \${n.read ? 'read' : 'unread'}\`}
                onClick={() => onNotificationClick(n.id)}
              >
                <span className="notification-message">{n.message}</span>
                <span className="notification-time">{new Date(n.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="activity-panel">
          <h2>Recent Activity</h2>
          <ul className="activity-list">
            {activities.slice(0, 10).map(a => (
              <li key={a.id} className="activity-item" onClick={() => onActivityClick(a.id)}>
                <span className="activity-action">{a.action}</span>
                <span className="activity-target">{a.target}</span>
                <span className="activity-time">{new Date(a.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>

    <footer className="dashboard-footer">
      <p>&copy; {new Date().getFullYear()} Dashboard App</p>
    </footer>
  </div>
);`,
    expectedPatterns: [
      'React.createElement',
      'dashboard',
      'user.name',
      'stats.map',
      'notifications',
      'activities',
      'stat.value',
      'stat.change',
      'n.message',
      'a.action',
    ],
    forbiddenPatterns: [
      'interface User',
      'interface Stat',
      'interface Notification',
      'interface Activity',
      'interface DashboardProps',
    ],
  },
];

/**
 * Get examples filtered by complexity level
 */
export function getExamplesByLevel(level: ComplexityLevel): ComponentExample[] {
  return BABEL_EXAMPLES.filter((e) => e.level === level);
}

/**
 * Get a single example by ID
 */
export function getExampleById(id: number): ComponentExample | undefined {
  return BABEL_EXAMPLES.find((e) => e.id === id);
}

/**
 * Get all example IDs for a complexity level
 */
export function getExampleIdsByLevel(level: ComplexityLevel): number[] {
  return BABEL_EXAMPLES.filter((e) => e.level === level).map((e) => e.id);
}

/**
 * Calculate total code size for a set of examples
 */
export function calculateTotalCodeSize(examples: ComponentExample[]): number {
  return examples.reduce((sum, e) => sum + e.code.length, 0);
}

/**
 * Get complexity level statistics
 */
export function getLevelStats(): Record<ComplexityLevel, { count: number; totalSize: number; avgSize: number }> {
  const stats: Record<ComplexityLevel, { count: number; totalSize: number; avgSize: number }> = {} as never;

  for (const level of COMPLEXITY_LEVELS) {
    const examples = getExamplesByLevel(level);
    const totalSize = calculateTotalCodeSize(examples);
    stats[level] = {
      count: examples.length,
      totalSize,
      avgSize: examples.length > 0 ? totalSize / examples.length : 0,
    };
  }

  return stats;
}
