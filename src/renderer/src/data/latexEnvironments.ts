// Static LaTeX environment names for \begin{} completion
// Each entry: [name, detail, snippet body (optional)]

export interface LatexEnvironment {
  name: string
  detail?: string
  body?: string   // default body inside the environment (e.g. column spec for tabular)
}

export const latexEnvironments: LatexEnvironment[] = [
  // ── Document ──
  { name: 'document', detail: 'Main document body' },

  // ── Lists ──
  { name: 'itemize', detail: 'Unordered list', body: '\\item $1' },
  { name: 'enumerate', detail: 'Ordered list', body: '\\item $1' },
  { name: 'description', detail: 'Description list', body: '\\item[$1] $2' },

  // ── Math ──
  { name: 'equation', detail: 'Numbered equation' },
  { name: 'equation*', detail: 'Unnumbered equation' },
  { name: 'align', detail: 'Aligned equations' },
  { name: 'align*', detail: 'Aligned equations (unnumbered)' },
  { name: 'gather', detail: 'Gathered equations' },
  { name: 'gather*', detail: 'Gathered equations (unnumbered)' },
  { name: 'multline', detail: 'Multi-line equation' },
  { name: 'multline*', detail: 'Multi-line (unnumbered)' },
  { name: 'split', detail: 'Split equation' },
  { name: 'flalign', detail: 'Full-width align' },
  { name: 'flalign*', detail: 'Full-width align (unnumbered)' },
  { name: 'alignat', detail: 'Align at columns' },
  { name: 'alignat*', detail: 'Align at (unnumbered)' },
  { name: 'math', detail: 'Inline math environment' },
  { name: 'displaymath', detail: 'Display math environment' },
  { name: 'cases', detail: 'Piecewise cases' },

  // ── Matrices ──
  { name: 'matrix', detail: 'Plain matrix' },
  { name: 'pmatrix', detail: 'Parenthesized matrix' },
  { name: 'bmatrix', detail: 'Bracketed matrix' },
  { name: 'Bmatrix', detail: 'Braced matrix' },
  { name: 'vmatrix', detail: 'Determinant matrix' },
  { name: 'Vmatrix', detail: 'Double-bar matrix' },
  { name: 'smallmatrix', detail: 'Small inline matrix' },

  // ── Tables ──
  { name: 'tabular', detail: 'Table', body: '{${1:lll}}\n\\hline\n$2 \\\\\\\\\n\\hline' },
  { name: 'tabular*', detail: 'Table with width' },
  { name: 'tabularx', detail: 'Table with X columns' },
  { name: 'longtable', detail: 'Multi-page table' },
  { name: 'array', detail: 'Math array', body: '{${1:lll}}\n$2' },

  // ── Floats ──
  { name: 'figure', detail: 'Figure float', body: '\\centering\n\\includegraphics[width=\\textwidth]{$1}\n\\caption{$2}\n\\label{fig:$3}' },
  { name: 'figure*', detail: 'Full-width figure' },
  { name: 'table', detail: 'Table float', body: '\\centering\n\\caption{$1}\n\\label{tab:$2}\n\\begin{tabular}{${3:lll}}\n\\hline\n$4 \\\\\\\\\n\\hline\n\\end{tabular}' },
  { name: 'table*', detail: 'Full-width table float' },

  // ── Text layout ──
  { name: 'center', detail: 'Centered text' },
  { name: 'flushleft', detail: 'Left-aligned text' },
  { name: 'flushright', detail: 'Right-aligned text' },
  { name: 'minipage', detail: 'Mini page', body: '{${1:\\textwidth}}\n$2' },
  { name: 'quote', detail: 'Indented quote' },
  { name: 'quotation', detail: 'Indented quotation' },
  { name: 'verse', detail: 'Verse' },
  { name: 'abstract', detail: 'Abstract' },
  { name: 'verbatim', detail: 'Verbatim text' },

  // ── Frames / boxes ──
  { name: 'frame', detail: 'Beamer frame', body: '{${1:Title}}\n$2' },
  { name: 'block', detail: 'Beamer block', body: '{${1:Title}}\n$2' },
  { name: 'columns', detail: 'Beamer columns' },
  { name: 'column', detail: 'Beamer column', body: '{${1:0.5\\textwidth}}\n$2' },

  // ── Code / listings ──
  { name: 'lstlisting', detail: 'Code listing' },
  { name: 'minted', detail: 'Minted code', body: '{${1:python}}\n$2' },

  // ── TikZ ──
  { name: 'tikzpicture', detail: 'TikZ picture' },
  { name: 'scope', detail: 'TikZ scope' },

  // ── Theorem-like ──
  { name: 'theorem', detail: 'Theorem' },
  { name: 'lemma', detail: 'Lemma' },
  { name: 'corollary', detail: 'Corollary' },
  { name: 'proposition', detail: 'Proposition' },
  { name: 'definition', detail: 'Definition' },
  { name: 'example', detail: 'Example' },
  { name: 'remark', detail: 'Remark' },
  { name: 'proof', detail: 'Proof' },

  // ── Misc ──
  { name: 'thebibliography', detail: 'Bibliography', body: '{${1:99}}\n\\bibitem{$2} $3' },
  { name: 'appendix', detail: 'Appendix' },
  { name: 'titlepage', detail: 'Title page' },
]
