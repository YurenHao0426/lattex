// Ported verbatim from Overleaf (bibliography-styles.ts + class-names.ts), AGPL-3.0.
export const bibliographyStyles: Record<string, string[]> = {
  // https://www.overleaf.com/learn/latex/Bibtex_bibliography_styles
  bibtex: [
    'abbrv',
    'acm',
    'alpha',
    'apalike',
    'ieeetr',
    'plain',
    'siam',
    'unsrt',
  ],
  // https://www.overleaf.com/learn/latex/Natbib_bibliography_styles
  natbib: ['dinat', 'plainnat', 'abbrvnat', 'unsrtnat', 'rusnat', 'ksfh_nat'],
  // https://www.overleaf.com/learn/latex/Biblatex_bibliography_styles
  biblatex: [
    'numeric',
    'alphabetic',
    'authoryear',
    'authortitle',
    'verbose',
    'reading',
    'draft',
    'authoryear-icomp',
    'apa',
    'bwl-FU',
    'chem-acs',
    'chem-angew',
    'chem-biochem',
    'chem-rsc',
    'ieee',
    'mla',
    'musuos',
    'nature',
    'nejm',
    'phys',
    'science',
    'geschichtsfrkl',
    'oscola',
  ],
  // https://ctan.org/tex-archive/macros/latex/contrib/biblatex-contrib
  'biblatex-contrib': [
    // TODO
  ],
}

// https://www.overleaf.com/learn/latex/Creating_a_document_in_LaTeX#Reference_guide

// TODO: more class names
export const classNames = [
  'article',
  'report',
  'book',
  'letter',
  // 'slides',
  'beamer',
]
