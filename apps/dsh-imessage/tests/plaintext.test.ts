import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from '../src/plaintext.js'

describe('markdown to plain text', () => {
  it('passes plain text through unchanged', () => {
    expect(markdownToPlainText('hello world')).toBe('hello world')
    expect(markdownToPlainText('')).toBe('')
    expect(markdownToPlainText('line one\nline two')).toBe('line one\nline two')
  })

  it('strips ATX and setext headings but keeps their text', () => {
    expect(markdownToPlainText('# Title')).toBe('Title')
    expect(markdownToPlainText('## Sub\n### Deep')).toBe('Sub\nDeep')
    expect(markdownToPlainText('Title\n=======')).toBe('Title')
    expect(markdownToPlainText('Subtitle\n-------')).toBe('Subtitle')
    expect(markdownToPlainText('# Heading with *emphasis*')).toBe('Heading with emphasis')
  })

  it('removes emphasis and strong markers', () => {
    expect(markdownToPlainText('**bold**')).toBe('bold')
    expect(markdownToPlainText('*italic*')).toBe('italic')
    expect(markdownToPlainText('***both***')).toBe('both')
    expect(markdownToPlainText('__bold__')).toBe('bold')
    expect(markdownToPlainText('_italic_')).toBe('italic')
    expect(markdownToPlainText('plain **bold** and *em*')).toBe('plain bold and em')
    expect(markdownToPlainText('**a *b* c**')).toBe('a b c')
  })

  it('leaves intraword punctuation alone', () => {
    expect(markdownToPlainText('use snake_case names')).toBe('use snake_case names')
    expect(markdownToPlainText('a*b*c')).toBe('a*b*c')
    expect(markdownToPlainText('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  it('keeps inline code contents verbatim', () => {
    expect(markdownToPlainText('run `npm test` now')).toBe('run npm test now')
    expect(markdownToPlainText('literal `` `code` `` block')).toBe('literal `code` block')
  })

  it('keeps fenced code blocks verbatim and drops the language line', () => {
    expect(markdownToPlainText('```js\nconst x = 1\n```')).toBe('const x = 1')
    expect(markdownToPlainText('before\n\n```sh\nnpm test -- --run\n```\n\nafter'))
      .toBe('before\n\nnpm test -- --run\n\nafter')
    expect(markdownToPlainText('~~~\nkeep # comments as-is\n~~~')).toBe('keep # comments as-is')
  })

  it('renders links, images, and autolinks as readable text', () => {
    expect(markdownToPlainText('[docs](https://example.com)')).toBe('docs (https://example.com)')
    expect(markdownToPlainText('[docs](https://example.com "title")')).toBe('docs (https://example.com)')
    expect(markdownToPlainText('![alt](https://example.com/i.png)')).toBe('alt')
    expect(markdownToPlainText('[reference][ref]')).toBe('reference')
    expect(markdownToPlainText('<https://example.com>')).toBe('https://example.com')
    expect(markdownToPlainText('<ada@example.com>')).toBe('ada@example.com')
    expect(markdownToPlainText('See [docs](https://example.com) for details'))
      .toBe('See docs (https://example.com) for details')
  })

  it('drops link definitions', () => {
    expect(markdownToPlainText('[ref]: https://example.com\nplain')).toBe('plain')
  })

  it('unwraps blockquotes', () => {
    expect(markdownToPlainText('> quote')).toBe('quote')
    expect(markdownToPlainText('> first\n> second')).toBe('first\nsecond')
    expect(markdownToPlainText('>> nested')).toBe('nested')
  })

  it('keeps list markers and task lists readable', () => {
    expect(markdownToPlainText('- one\n- two')).toBe('- one\n- two')
    expect(markdownToPlainText('1. one\n2. two')).toBe('1. one\n2. two')
    expect(markdownToPlainText('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo')
  })

  it('flattens tables into pipe-separated rows without the delimiter row', () => {
    expect(markdownToPlainText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a | b\n\n1 | 2')
  })

  it('removes strikethrough markers', () => {
    expect(markdownToPlainText('~~gone~~')).toBe('gone')
  })

  it('drops horizontal rules', () => {
    expect(markdownToPlainText('a\n\n---\n\nb')).toBe('a\n\nb')
    expect(markdownToPlainText('a\n\n***\n\nb')).toBe('a\n\nb')
  })

  it('strips html tags but keeps their text and <br> line breaks', () => {
    expect(markdownToPlainText('<b>bold</b>')).toBe('bold')
    expect(markdownToPlainText('line<br>break')).toBe('line\nbreak')
  })

  it('honours backslash escapes', () => {
    expect(markdownToPlainText('\\*not em\\*')).toBe('*not em*')
    expect(markdownToPlainText('\\# not a heading')).toBe('# not a heading')
  })

  it('decodes common entities after tag stripping', () => {
    expect(markdownToPlainText('a &amp; b')).toBe('a & b')
    expect(markdownToPlainText('&lt;tag&gt;')).toBe('<tag>')
  })

  it('collapses excessive blank lines', () => {
    expect(markdownToPlainText('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('converts a realistic answer end to end', () => {
    const answer = [
      '## Fix',
      '',
      'Run `npm test`:',
      '',
      '```sh',
      'npm test',
      '```',
      '',
      '- one',
      '- two',
      '',
      '> note',
      '',
      'See [docs](https://example.com).',
    ].join('\n')
    expect(markdownToPlainText(answer)).toBe([
      'Fix',
      '',
      'Run npm test:',
      '',
      'npm test',
      '',
      '- one',
      '- two',
      '',
      'note',
      '',
      'See docs (https://example.com).',
    ].join('\n'))
  })
})
