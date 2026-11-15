import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
markdown.validateLink = url => /^(https?:\/\/|mailto:)/i.test(url)
markdown.renderer.rules.image = (tokens, index, _options, _env, renderer) =>
  markdown.utils.escapeHtml(renderer.renderInlineAsText(tokens[index].children ?? [], {}, {}))
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderer.renderToken(tokens, index, options)
}

export function renderMarkdown(reply) {
  const text = reply.trim()
  // Some scenes wrap their entire answer in a Markdown fence.
  const wrapped = text.match(/^(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n\1$/i)
  return markdown.render(wrapped ? wrapped[2] : text)
}
