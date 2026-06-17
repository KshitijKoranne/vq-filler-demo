export type KnowledgeSourceType = 'policy' | 'procedure' | 'previous_questionnaire' | 'standard_answer' | 'other';

export type KnowledgeChunk = {
  id: string;
  source_name: string;
  source_type: KnowledgeSourceType;
  chunk_text: string;
  similarity?: number;
};

export type KnowledgeSourceSummary = {
  sourceName: string;
  sourceType: KnowledgeSourceType;
  chunks: number;
  latestIngestedAt: string;
};

export type QuestionCandidate = {
  id: string;
  question: string;
  location: {
    kind: 'table_cell';
    rowIndex: number;
    questionCellIndex: number;
    answerCellIndex: number;
    yesCellIndex?: number;
    noCellIndex?: number;
    naCellIndex?: number;
    explanationCellIndex?: number;
  };
};

export type GeneratedAnswer = {
  questionId: string;
  question: string;
  answer: string;
  status: 'answered' | 'blank' | 'review';
  confidence: number;
  reason: string;
  evidence: Array<{
    sourceName: string;
    excerpt: string;
  }>;
};

export type FillDebugEntry = {
  questionId: string;
  stage: 'extraction' | 'retrieval' | 'answering' | 'writeback' | 'error';
  question: string;
  rowIndex?: number;
  questionCellIndex?: number;
  answerCellIndex?: number;
  yesCellIndex?: number;
  noCellIndex?: number;
  naCellIndex?: number;
  explanationCellIndex?: number;
  intent?: string;
  retrievedChunks?: number;
  topMatches?: Array<{
    sourceName: string;
    similarity: number;
    excerpt: string;
  }>;
  answerStatus?: GeneratedAnswer['status'];
  answerPreview?: string;
  confidence?: number;
  reason?: string;
  timingsMs?: {
    retrieval?: number;
    answering?: number;
    total?: number;
  };
  message: string;
};

export type FillResult = {
  fileName: string;
  totalQuestions: number;
  answered: number;
  needsReview: number;
  blank: number;
  answers: GeneratedAnswer[];
  outputBase64: string;
  debug?: FillDebugEntry[];
};
