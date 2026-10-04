import { createHash } from 'node:crypto';

const replyStart = '<send_user_message_question_reply>';
const replyEnd = '</send_user_message_question_reply>';

function shortId(value) {
  return `async-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function valuesFor(state) {
  const entities = state?.turnHistory?.history?.entitiesByKey;
  if (entities && typeof entities === 'object') return Object.values(entities);
  return (state?.turns ?? []).flatMap(turn => turn.items ?? []);
}

function answeredIds(state) {
  const answered = new Set();
  for (const entity of valuesFor(state)) {
    if (!['userMessage', 'steeringUserMessage'].includes(entity?.type)) continue;
    const content = entity.content ?? entity.input;
    const text = Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : null;
    if (typeof text !== 'string' || !text.trim().startsWith(replyStart) || !text.trim().endsWith(replyEnd)) continue;
    try {
      const payload = JSON.parse(text.trim().slice(replyStart.length, -replyEnd.length));
      for (const item of Array.isArray(payload) ? payload : [payload]) if (typeof item?.questionItemId === 'string') answered.add(item.questionItemId);
    } catch { /* malformed historical text is not an answer */ }
  }
  return answered;
}

export function extractDesktopQuestions(state) {
  const answered = answeredIds(state);
  const requests = [];
  const unrepresentable = [];
  for (const entity of valuesFor(state)) {
    if (entity?.type !== 'agentMessage' || !Array.isArray(entity.questions)) continue;
    entity.questions.forEach((question, index) => {
      const questionItemId = JSON.stringify(['request_user_input_async', entity.id, index]);
      if (answered.has(questionItemId)) return;
      const options = Array.isArray(question.options) ? question.options : [];
      if (!question.title || options.length < 2 || options.length > 3 || options.some(option => typeof option !== 'string' || !option)) {
        unrepresentable.push({ questionItemId, reason: 'unsupported-options' }); return;
      }
      requests.push({
        id: shortId(questionItemId),
        questionItemId,
        method: 'item/tool/requestUserInput',
        params: { threadId: state.id, turnId: entity.id, questions: [{ id: shortId(questionItemId), question: question.title, options: options.map(label => ({ label, description: label })) }] },
      });
    });
  }
  return { requests, unrepresentable };
}

export function asyncQuestionReply(questionItemId, question, answer) {
  return `${replyStart}\n${JSON.stringify({ questionItemId, question, answer })}\n${replyEnd}`;
}
