const crypto = require('crypto');
const { Configuration, OpenAIApi } = require('openai');
const Koa = require('koa');
const Router = require('koa-router');
const logger = require('koa-logger');
const bodyParser = require('koa-bodyparser');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  init: initDB,
  Counter,
  Message,
  MESSAGE_STATUS_ANSWERED,
  MESSAGE_STATUS_THINKING,
  AI_TYPE_TEXT,
  AI_TYPE_IMAGE,
} = require('./db');
const crypto = require('crypto');
const xml2js = require('xml2js');

const builder = new xml2js.Builder({
  rootName: 'xml',
  cdata: true,
  headless: true,
});

const parser = new xml2js.Parser({
  explicitArray: false,
  explicitRoot: false,
  ignoreAttrs: true,
  tagNameProcessors: [xml2js.processors.stripPrefix],
});

const router = new Router();

const homePage = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

// 清空指令
const CLEAR_KEY = 'CLEAR_';
const CLEAR_KEY_TEXT = `${CLEAR_KEY}0`;
const CLEAR_KEY_IMAGE = `${CLEAR_KEY}1`;

const AI_IMAGE_KEY = '作画';

const AI_THINKING_MESSAGE = '我已经在编了，请稍等几秒后复制原文再说一遍~';

const LIMIT_AI_TEXT_COUNT = 10;
const LIMIT_AI_IMAGE_COUNT = 5;

const LIMIT_COUNT_RESPONSE =
  '对不起，因为ChatGPT调用收费，您的免费使用额度已用完~';

const configuration = new Configuration({
  apiKey: 'YOUR_API_KEY', // 请替换为自己的 OpenAI API Key
});

const openai = new OpenAIApi(configuration);

async function buildCtxPrompt({ FromUserName }) {
  // 获取最近对话
  const messages = await Message.findAll({
    where: {
      fromUser: FromUserName,
      aiType: AI_TYPE_TEXT,
    },
    limit: LIMIT_AI_TEXT_COUNT,
    order: [['updatedAt', 'ASC']],
  });
  // 只有一条的时候，就不用封装上下文了
  return messages.length === 1
    ? messages[0].request
    : messages
        .map(({ response, request }) => `Q: ${request}\n A: ${response}`)
        .join('\n');
}

async function getAIResponse(prompt) {
  const completion = await openai.createCompletion({
    model: 'text-davinci-003',
    prompt,
    max_tokens: 1024,
    temperature: 0.1,
  });

  const response = (completion?.data?.choices?.[0].text || 'AI 挂了').trim();

  return strip(response, ['\n', 'A: ']);
}

async function getAIIMAGE(prompt) {
  const response = await openai.createImage({
    prompt: prompt,
    n: 1,
    size: '1024x1024',
  });

  const imageURL = response?.data?.data?.[0].url || 'AI 作画挂了';

  return imageURL
}

async function getAIMessage({ Content, FromUserName }) {
// 找一下，是否已有记录
const message = await Message.findOne({
where: {
fromUser: FromUserName,
request: Content,
},
});

// 已回答，直接返回消息
if (message?.status === MESSAGE_STATUS_ANSWERED) {
return `[GPT]: ${message?.response}`;
}

// 在回答中
if (message?.status === MESSAGE_STATUS_THINKING) {
return AI_THINKING_MESSAGE;
}

const aiType = Content.startsWith(AI_IMAGE_KEY)
? AI_TYPE_IMAGE
: AI_TYPE_TEXT;

// 检查一下历史消息记录，不能超过限制
const count = await Message.count({
where: {
fromUser: FromUserName,
aiType: aiType,
},
});

// 超过限制，返回提示
if (aiType === AI_TYPE_TEXT && count >= LIMIT_AI_TEXT_COUNT) {
return LIMIT_COUNT_RESPONSE;
}

// 超过限制，返回提示
if (aiType === AI_TYPE_IMAGE && count >= LIMIT_AI_IMAGE_COUNT) {
return LIMIT_COUNT_RESPONSE;
}

// 没超过限制时，正常走AI链路
// 因为AI响应比较慢，容易超时，先插入一条记录，维持状态，待后续更新记录。
await Message.create({
fromUser: FromUserName,
response: '',
request: Content,
aiType,
});

let response = '';

if (aiType === AI_TYPE_TEXT) {
// 构建带上下文的 prompt
const prompt = await buildCtxPrompt({ FromUserName });

// 请求远程消息
response = await getAIResponse(prompt);
}

if (aiType === AI_TYPE_IMAGE) {
// 去掉开始前的关键词
const prompt = Content.substring(AI_IMAGE_KEY.length);
// 请求远程消息
response = await getAIIMAGE(prompt);
}

// 成功后，更新记录
await Message.update(
{
response: response,
status: MESSAGE_STATUS_ANSWERED,
},
{
where: {
fromUser: FromUserName,
request: Content,
},
},
);

return `[GPT]: ${response}`;
}

async function validateSignature(ctx, next) {
const { signature, timestamp, nonce, echostr } = ctx.query;
const token = 'YOUR_TOKEN'; // 请替换为自己的 Token
const arr = [token, timestamp, nonce];
arr.sort();
const str = arr.join('');
const sha1 = crypto.createHash('sha1');
sha1.update(str);
const result = sha1.digest('hex');
if (signature === result) {
ctx.body = echostr;
} else {
ctx.body = 'Invalid signature';
}
}

async function handleMessage(ctx, next) {
const xml = ctx.request.body;
const message = await parser.parseStringPromise(xml);
const {
Content = '',
FromUserName = '',
ToUserName = '',
MsgType = '',
} = message;
if (MsgType === 'text') {
const result = await getAIMessage({ Content, FromUserName });
ctx.body = builder.buildObject({
ToUserName: FromUserName,
FromUserName: ToUserName,
CreateTime: +new Date(),
  MsgType: 'text',
  Content: result,
});
} else {
ctx.body = builder.buildObject({
ToUserName: FromUserName,
FromUserName: ToUserName,
CreateTime: +new Date(),
MsgType: 'text',
Content: '只支持文本消息',
});
}
}

router.get('/', validateSignature);
router.post('/', handleMessage);

const app = new Koa();
app.use(logger()).use(bodyParser()).use(router.routes()).use(router.allowedMethods());

const host = '127.0.0.1';
const port = process.env.PORT || 80;
async function bootstrap() {
await initDB();

app.listen(port, host, () => {
console.log(`启动成功 http://${host}:${port}`);
});
}

bootstrap();

module.exports = {
validateSignature,
handleMessage,
};