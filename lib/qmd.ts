type QmdRule = { pattern: RegExp; terms: string };

const QMD_RULES: QmdRule[] = [
  { pattern: /quality assurance|\bqa\b|quality unit|independent quality|kalite güvence/i, terms: 'quality assurance department independent quality unit quality oversight responsibilities organization hierarchy' },
  { pattern: /quality manual|quality system|\bqms\b|iso|gmp|cgmp|brc|kalite sistemi/i, terms: 'quality manual quality management system GMP ISO compliance quality policy certification' },
  { pattern: /document|documentation|record|archive|procedure|\bsop\b|doküman|arşiv/i, terms: 'document control approved documents record retention archive period SOP review update controlled copy' },
  { pattern: /batch record|production record|release|reject|dispatch|serbest|ret|sevkiyat/i, terms: 'batch record review QA approval batch release product rejection dispatch production records' },
  { pattern: /traceability|lot|batch number|supplier detail|izlenebilir/i, terms: 'traceability batch number lot numbering raw material supplier records batch history' },
  { pattern: /deviation|non.?conformance|nonconformance|oos|oot|sapma|uygunsuz/i, terms: 'deviation nonconformance investigation root cause CAPA documentation quality event closure' },
  { pattern: /capa|corrective|preventive|düzeltici|önleyici/i, terms: 'corrective action preventive action CAPA root cause effectiveness check' },
  { pattern: /change control|change management|change|dmf|regulatory documentation|değişiklik/i, terms: 'change control QA approval customer notification regulatory documentation DMF impact assessment prior approval' },
  { pattern: /audit|self.?inspection|inspection|denetim/i, terms: 'internal audit self inspection supplier audit audit plan audit frequency audit records corrective actions' },
  { pattern: /complaint|recall|return|şikayet|geri çek/i, terms: 'customer complaint product complaint recall returned goods investigation written procedure' },
  { pattern: /supplier|vendor|approved supplier|qualification|tedarikçi/i, terms: 'supplier qualification vendor approval approved supplier list supplier evaluation supplier monitoring' },
  { pattern: /training|personnel|employee|hygiene|gowning|medical|eğitim|hijyen/i, terms: 'personnel training GMP training hygiene gowning job description qualification training records medical check induction' },
  { pattern: /material|raw material|warehouse|storage|temperature|humidity|fifo|fefo|hammadde|depo/i, terms: 'material management raw material receipt sampling testing release warehouse storage condition temperature humidity FIFO FEFO' },
  { pattern: /quarantine|approved|rejected|label|erp|etiket/i, terms: 'quarantine approved rejected status label ERP material status physical segregation inventory system' },
  { pattern: /equipment|calibration|maintenance|qualification|validation|ekipman|kalibrasyon/i, terms: 'equipment qualification calibration preventive maintenance logbook validation critical equipment records' },
  { pattern: /cleaning|sanitation|contamination|mix.?up|cross.?contamination|karışım/i, terms: 'cleaning sanitation contamination prevention mix-up prevention cross contamination risk assessment line clearance' },
  { pattern: /certificate|certification|approval|authorization|sertifika|izin/i, terms: 'certificate certification approval authorization GMP certificate ISO certificate manufacturing site approval valid certificate' },
  { pattern: /coa|certificate of analysis|analysis certificate|analiz sertifikası/i, terms: 'certificate of analysis COA raw material release testing specification analytical result manufacturer certificate' },
];

export function buildQmdQuery(question: string) {
  const base = question.replace(/\s+/g, ' ').trim();
  const matchedTerms = QMD_RULES.filter((rule) => rule.pattern.test(base)).map((rule) => rule.terms);
  const generalTerms = 'pharmaceutical GMP vendor questionnaire procedure system record responsibility approval review documented evidence';
  return Array.from(new Set([base, generalTerms, ...matchedTerms])).join(' ');
}

