import abbreviation, { CSSAbbreviation, CSSProperty, CSSValue, Literal, Value, Field, FunctionCall } from '@emmetio/css-abbreviation';
import { Config, SnippetsMap } from '../config';
import createSnippet, { CSSSnippet, nest, CSSSnippetType, CSSSnippetRaw, CSSSnippetProperty } from './snippets';
import calculateScore from './score';
import color from './color';

type MatchInput = CSSSnippet | string;

/**
 * Parses given Emmet abbreviation into a final abbreviation tree with all
 * required transformations applied
 */
export default function parse(abbr: string | CSSAbbreviation, config: Config, snippets = convertSnippets(config.snippets)): CSSAbbreviation {
    if (typeof abbr === 'string') {
        abbr = abbreviation(abbr);
    }

    for (const node of abbr) {
        resolveNode(node, snippets, config);
    }

    return abbr;
}

export { default as stringify } from './format';

/**
 * Converts given raw snippets into internal snippets representation
 */
export function convertSnippets(snippets: SnippetsMap): CSSSnippet[] {
    const result: CSSSnippet[] = [];
    for (const key of Object.keys(snippets)) {
        result.push(createSnippet(key, snippets[key]));
    }

    return nest(result);
}

/**
 * Resolves given node: finds matched CSS snippets using fuzzy match and resolves
 * keyword aliases from node value
 */
function resolveNode(node: CSSProperty, snippets: CSSSnippet[], config: Config): CSSProperty {
    if (!resolveGradient(node, config)) {
        const score = config.options['stylesheet.fuzzySearchMinScore'];
        if (config.context) {
            // Resolve as value of given CSS property
            const snippet = snippets.find(s => s.type === CSSSnippetType.Property && s.property === config.context) as CSSSnippetProperty | undefined;
            resolveValueKeywords(node, config, snippet, score);
        } else if (node.name) {
            const snippet = findBestMatch(node.name, snippets, score);

            if (snippet) {
                if (snippet.type === CSSSnippetType.Property) {
                    resolveAsProperty(node, snippet, config);
                } else {
                    resolveAsSnippet(node, snippet);
                }
            }
        }
    }

    resolveNumericValue(node, config);

    return node;
}

/**
 * Resolves CSS gradient shortcut from given propert, if possible
 */
function resolveGradient(node: CSSProperty, config: Config): boolean {
    let gradientFn: FunctionCall | null = null;
    const cssVal = node.value.length === 1 ? node.value[0]! : null;

    if (cssVal && cssVal.value.length === 1) {
        const v = cssVal.value[0]!;
        if (v.type === 'FunctionCall' && v.name === 'lg') {
            gradientFn = v;
        }
    }

    if (gradientFn || node.name === 'lg') {
        if (!gradientFn) {
            gradientFn = {
                type: 'FunctionCall',
                name: 'linear-gradient',
                arguments: [cssValue(field(0, ''))]
            };
        } else {
            gradientFn = {
                ...gradientFn,
                name: 'linear-gradient'
            };
        }

        if (!config.context) {
            node.name = 'background-image';
        }
        node.value = [cssValue(gradientFn)];
        return true;
    }

    return false;
}

/**
 * Resolves given parsed abbreviation node as CSS property
 */
function resolveAsProperty(node: CSSProperty, snippet: CSSSnippetProperty, config: Config): CSSProperty {
    const abbr = node.name!;
    node.name = snippet.property;

    if (!node.value.length) {
        // No value defined in abbreviation node, try to resolve unmatched part
        // as a keyword alias
        const inlineValue = getUnmatchedPart(abbr, snippet.key);
        const kw = inlineValue ? resolveKeyword(inlineValue, config, snippet) : null;
        if (kw) {
            node.value.push(cssValue(kw));
        } else if (snippet.value.length) {
            const defaultValue = snippet.value[0]!;

            // https://github.com/emmetio/emmet/issues/558
            // We should auto-select inserted value only if there’s multiple value
            // choice
            node.value = snippet.value.length === 1 || defaultValue.some(hasField)
                ? defaultValue
                : defaultValue.map(n => wrapWithField(n, config));
        }
    } else {
        // Replace keyword alias from current abbreviation node with matched keyword
        resolveValueKeywords(node, config, snippet);
    }

    return node;
}

function resolveValueKeywords(node: CSSProperty, config: Config, snippet?: CSSSnippetProperty, minScore?: number) {
    for (const cssVal of node.value) {
        const value: Value[] = [];
        for (const token of cssVal.value) {
            if (token.type === 'Literal') {
                value.push(resolveKeyword(token.value, config, snippet, minScore) || token);
            } else if (token.type === 'FunctionCall') {
                // For function calls, we should find matching function call
                // and merge arguments
                const match = resolveKeyword(token.name, config, snippet, minScore);
                if (match && match.type === 'FunctionCall') {
                    value.push({
                        ...match,
                        arguments: token.arguments.concat(match.arguments.slice(token.arguments.length))
                    });
                } else {
                    value.push(token);
                }
            } else {
                value.push(token);
            }
        }
        cssVal.value = value;
    }
}

/**
 * Resolves given parsed abbreviation node as a snippet: a plain code chunk
 */
function resolveAsSnippet(node: CSSProperty, snippet: CSSSnippetRaw): CSSProperty {
    return setNodeAsText(node, snippet.value);
}

/**
 * Sets given parsed abbreviation node as a text snippet
 */
function setNodeAsText(node: CSSProperty, text: string): CSSProperty {
    node.name = void 0;
    node.value = [cssValue(literal(text))];
    return node;
}

/**
 * Finds best matching item from `items` array
 * @param abbr  Abbreviation to match
 * @param items List of items for match
 * @param minScore The minimum score the best matched item should have to be a valid match.
 */
export function findBestMatch<T extends MatchInput>(abbr: string, items: T[], minScore = 0): T | null {
    let matchedItem: T | null = null;
    let maxScore = 0;

    for (const item of items) {
        const score = calculateScore(abbr, getScoringPart(item));

        if (score === 1) {
            // direct hit, no need to look further
            return item;
        }

        if (score && score >= maxScore) {
            maxScore = score;
            matchedItem = item;
        }
    }

    return maxScore >= minScore ? matchedItem : null;
}

function getScoringPart(item: MatchInput): string {
    return typeof item === 'string' ? item : item.key;
}

/**
 * Returns a part of `abbr` that wasn’t directly matched against `str`.
 * For example, if abbreviation `poas` is matched against `position`,
 * the unmatched part will be `as` since `a` wasn’t found in string stream
 */
function getUnmatchedPart(abbr: string, str: string): string {
    for (let i = 0, lastPos = 0; i < abbr.length; i++) {
        lastPos = str.indexOf(abbr[i], lastPos);
        if (lastPos === -1) {
            return abbr.slice(i);
        }
        lastPos++;
    }

    return '';
}

/**
 * Resolves given keyword shorthand into matched snippet keyword or global keyword,
 * if possible
 */
function resolveKeyword(kw: string, config: Config, snippet?: CSSSnippetProperty, minScore?: number): Literal | FunctionCall | null {
    let ref: string | null;

    if (snippet) {
        if (ref = findBestMatch(kw, Object.keys(snippet.keywords), minScore)) {
            return snippet.keywords[ref];
        }

        for (const dep of snippet.dependencies) {
            if (ref = findBestMatch(kw, Object.keys(dep.keywords), minScore)) {
                return dep.keywords[ref];
            }
        }
    }

    if (ref = findBestMatch(kw, config.options['stylesheet.keywords'], minScore)) {
        return literal(ref);
    }

    return null;
}

/**
 * Resolves numeric values in given abbreviation node
 */
function resolveNumericValue(node: CSSProperty, config: Config) {
    const aliases = config.options['stylesheet.unitAliases'];
    const unitless = config.options['stylesheet.unitless'];

    for (const v of node.value) {
        for (const t of v.value) {
            if (t.type === 'NumberValue') {
                if (t.unit) {
                    t.unit = aliases[t.unit] || t.unit;
                } else if (t.value !== 0 && !unitless.includes(node.name!)) {
                    // use `px` for integers, `em` for floats
                    // NB: num|0 is a quick alternative to Math.round(0)
                    t.unit = t.value === (t.value | 0)
                        ? config.options['stylesheet.intUnit']
                        : config.options['stylesheet.floatUnit'];
                }
            }
        }
    }
}

/**
 * Constructs CSS value token
 */
function cssValue(...args: Value[]): CSSValue {
    return {
        type: 'CSSValue',
        value: args
    };
}

/**
 * Constructs literal token
 */
function literal(value: string): Literal {
    return { type: 'Literal', value };
}

/**
 * Constructs field token
 */
function field(index: number, name: string): Field {
    return { type: 'Field', index, name };
}

/**
 * Check if given value contains fields
 */
function hasField(value: CSSValue): boolean {
    for (const v of value.value) {
        if (v.type === 'Field' || (v.type === 'FunctionCall' && v.arguments.some(hasField))) {
            return true;
        }
    }

    return false;
}

interface WrapState {
    index: number;
}

/**
 * Wraps tokens of given abbreviation with fields
 */
function wrapWithField(node: CSSValue, config: Config, state: WrapState = { index: 1 }): CSSValue {
    let value: Value[] = [];
    for (const v of node.value) {
        switch (v.type) {
            case 'ColorValue':
                value.push(field(state.index++, color(v, config.options['stylesheet.shortHex'])));
                break;
            case 'Literal':
                value.push(field(state.index++, v.value));
                break;
            case 'NumberValue':
                value.push(field(state.index++, `${v.value}${v.unit}`));
                break;
            case 'StringValue':
                const q = v.quote === 'single' ? '\'' : '"';
                value.push(field(state.index++, q + v.value + q));
                break;
            case 'FunctionCall':
                value.push(field(state.index++, v.name), literal('('));
                for (let i = 0, il = v.arguments.length; i < il; i++) {
                    value = value.concat(wrapWithField(v.arguments[i], config, state).value);
                    if (i !== il - 1) {
                        value.push(literal(', '));
                    }
                }
                value.push(literal(')'));
                break;
            default:
                value.push(v);
        }
    }

    return {...node, value };
}
