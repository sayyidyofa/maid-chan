import {
    Client,
    middleware,
    MessageEvent,
    Config,
    ClientConfig,
    MiddlewareConfig,
    JSONParseError,
    WebhookRequestBody, TextMessage, ReplyableEvent, MessageAPIResponseBase
} from '@line/bot-sdk';
import * as bodyParser from "body-parser";
import express, {NextFunction, Request, Response} from "express";
import {check, validationResult} from "express-validator";
import { createClient } from "redis";
import { status } from "minecraft-server-util";
import {StatusResponse} from "minecraft-server-util/dist/model/StatusResponse";

const server = express();

const lineConfig = <Config>{
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
    channelSecret: process.env.CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET'
}
const lineClient = new Client(<ClientConfig>lineConfig);

const redisConfig = process.env.REDIS_URL || 'redis://localhost:6379/'
const redisClient = createClient(redisConfig)

enum commandType {
    HELP,
    MCSTATUS,
    INVALID
}

enum replyErrors {
    REDIS_FAIL_GET = "redis_fail_get",
    REDIS_NOT_STRING = "redis_not_string",
    MC_QUERY_FAIL = "mc_query_fail"
}

const extractCommand = (message: string): commandType => {
    if (message.indexOf("/help") !== -1) return commandType.HELP;
    else if (message.indexOf("/mcstatus") !== -1) return commandType.MCSTATUS;
    else return commandType.INVALID
}

const linePromiseReply = (event: ReplyableEvent, text: string): Promise<MessageAPIResponseBase> => {
    return lineClient.replyMessage(event.replyToken, <TextMessage> {
        type: "text",
        text: text
    });
}

const formatServerResponse = (srvResp: StatusResponse, ngrokPort?: string): string =>
    `
    Server address: ${srvResp.host}\n
    Server port: ${ngrokPort === undefined ? '25565': ngrokPort}
    Server version: ${srvResp.version}\n
    Online players: ${srvResp.onlinePlayers}/${srvResp.maxPlayers}
    Players: ${
        srvResp.samplePlayers === null || srvResp.samplePlayers.length < 1 
        ? 'none' 
        : srvResp.samplePlayers.map(v=>v.name).toString()
    }\n
    Server Description: ${srvResp.description} 
    `

const helpMessage = "" +
    "Command list:\n" +
    "/help Display this message\n" +
    "/mcstatus Check the status of my master's Minecraft Server\n"

const handleEvent = ({events}: WebhookRequestBody): Array<Promise<MessageAPIResponseBase> | undefined> =>
    events.map(webhookEvent => {
        switch (webhookEvent.type) {
            case "message":
                switch ((<MessageEvent>webhookEvent).message.type) {
                    case "text":
                        switch (extractCommand((<TextMessage>(<MessageEvent>webhookEvent).message).text)) {
                            case commandType.HELP:
                                return linePromiseReply(<ReplyableEvent>webhookEvent, helpMessage)
                            case commandType.MCSTATUS:
                                redisClient.get("serverURL", (err, reply) => {
                                    if (err !== null) {
                                        return linePromiseReply(<ReplyableEvent>webhookEvent, `Server is offline. Code: ${replyErrors.REDIS_FAIL_GET}`)
                                    } else {
                                        switch (typeof reply) {
                                            case "string":
                                                return status(new URL(reply).hostname, {port: parseInt(new URL(reply).port)})
                                                    .then(serverResponse => linePromiseReply(<ReplyableEvent>webhookEvent, formatServerResponse(serverResponse, new URL(reply).port)))
                                                    .catch(() => linePromiseReply(<ReplyableEvent>webhookEvent, `Server is offline. Code: ${replyErrors.MC_QUERY_FAIL}`))
                                            default:
                                                return linePromiseReply(<ReplyableEvent>webhookEvent, `Server is offline. Code: ${replyErrors.REDIS_NOT_STRING}`)
                                        }
                                    }
                                })
                                break;
                            case commandType.INVALID:
                                return linePromiseReply(<ReplyableEvent>webhookEvent, "Invalid command. Type /help to get some help")
                        }
                }
                break;
            default:
                return undefined;
        }
    })

server.post("/webhook", middleware(<MiddlewareConfig>lineConfig), (req, res) => {
    Promise
        .all(handleEvent(<WebhookRequestBody>req.body).filter(v => v !== undefined))
        .then(res.json)
        .catch(reason => {
            res.status(400)
            console.error(reason)
            if (reason instanceof JSONParseError) {
                res.json(reason)
            } else res.send(reason)
        });
});

server.use(bodyParser.json())

const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers['authorization'] === undefined) {
        res.status(400)
        res.send("Undefined auth header")
        console.warn(`Undefined auth header from ${req.ip}:${req.socket.remotePort}`)
    } else {
        if (req.headers['authorization'] !== process.env.AUTH_KEY) {
            res.status(400)
            res.send("Invalid auth header")
            console.warn(`Invalid auth header from ${req.ip}:${req.socket.remotePort}`)
        } else next()
    }
}

const serverURLValidation = [
    [
        check("serverURL", "Please provide a valid Minecraft server URL").not().isEmpty().isURL({
            protocols: ["tcp"],
            require_protocol: true,
            validate_length: true,
            require_host: true,
            require_port: true
        })
    ],
    (req: Request, res: Response, next: NextFunction) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            res.json(errors)
            return;
        } else {
            next()
        }
    }
];

server.post("/serverURL", authMiddleware, ...serverURLValidation, (req: Request, res: Response) => {
    redisClient.set("serverURL", req.body.serverURL, (err, reply) => {
        if (err !== null) {
            console.warn(err)
            res.header(500)
            res.send("Server Error")
        } else {
            res.send(reply)
        }
    })
})

server.get('/', (req, res) => {
    res.send("Meow");
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
    console.log(`listening on ${port}`);
});
