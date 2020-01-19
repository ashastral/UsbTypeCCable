import { Client, Message, Guild, TextChannel, Snowflake, Channel, VoiceConnection, GuildMember, MessageAttachment } from "discord.js";
import config from "./config.json";
import low from "lowdb";
import FileSync from "lowdb/adapters/FileSync";
import moment, { Moment } from "moment";
import schedule from "node-schedule";
import stream from "stream";
import fs from "fs";
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";

type ScoreboardSchema = {
    [key: string]: { // userId
        score: number
    }
};

const DefaultScoreboard: (() => ScoreboardSchema) = () => ({});

type GuildSchema = {
    chargingChannel: Snowflake | null, // channelId
    chargingImageStart: Date | null,
    chargedUsers: Snowflake[] | null, // userId[]
    scoreboard: ScoreboardSchema
};

const DefaultGuild: (() => GuildSchema) = () => ({
    chargingChannel: null,
    chargingImageStart: null,
    chargedUsers: null,
    scoreboard: DefaultScoreboard()
});

type AppSchema = {
    guilds: {
        [key: string]: GuildSchema // guildId
    }
};

type MessageWithGuild = { guild: Guild } & Message;

const DefaultApp: (() => AppSchema) = () => ({
    guilds: {}
});

const adapter: low.AdapterSync<AppSchema> = new FileSync<AppSchema>("db/db.json");
const db: low.LowdbSync<AppSchema> = low(adapter);

if (!db.has("guilds").value()) {
    db.defaults(DefaultApp()).write();
}

const client: Client = new Client();

client.once("ready", () => {
    client.guilds.forEach((guild: Guild, guildId: Snowflake) => {
        registerGuild(guild);
    });
    if (client.user !== null) {
        client.user.setActivity(`${config.prefix}help`, {type: "PLAYING"});
    }
    console.log("Ready!");
});

client.on("guildCreate", registerGuild);

client.login(config.token);

type Command = {
    helpText: string,
    execute: (message: MessageWithGuild) => void
};

const commands: {[key: string]: Command} = {
    help: {
        helpText: "View this information",
        execute: function(message: MessageWithGuild): void {
            var allHelpText: string[] = [];
            Object.entries(commands).forEach(([commandName, command]: [string, Command]) => {
                allHelpText.push(`${config.prefix}${commandName} - ${command.helpText}`);
            });
            message.channel.send(allHelpText.join("\n"));
        }
    },

    scoreboard: {
        helpText: "View the charging speed scoreboard for this server",
        execute: function(message: MessageWithGuild): void {
            var scoreboard: ScoreboardSchema = db.get("guilds")
                .get(message.guild.id)
                .get("scoreboard", {})
                .value();
            type UserScore = {userId: Snowflake, score: number};
            var scoreArray: UserScore[] = Object.keys(scoreboard)
                .map((userId: Snowflake) => ({
                    userId: userId,
                    score: scoreboard[userId].score
                }));
            scoreArray.sort(userScore => userScore.score);
            var scoreMessageArray: string[] = [];
            scoreArray.forEach(userScore => {
                var user: GuildMember | undefined = message.guild.members.get(userScore.userId);
                var userDisplayName: string = (user === undefined) ? userScore.userId.toString() : user.displayName;
                scoreMessageArray.push("**" + userDisplayName + "**: " + userScore.score + "W");
            });
            message.channel.send("Scoreboard:\n" + scoreMessageArray.join("\n"));
        }
    },

    score: {
        helpText: "View your charging speed",
        execute: function(message: MessageWithGuild): void {
            var score: number = db.get("guilds")
                .get(message.guild.id)
                .get("scoreboard")
                .get(message.author.id)
                .get("score", config.scoreInitial)
                .value();
            message.channel.send(`<@${message.author.id}> Your score is **${score}${config.scoreSuffix}**.`);
        }
    },

    setChargingChannel: {
        helpText: "Set the channel for charging to the channel where the command was sent",
        execute: function(message: MessageWithGuild): void {
            db.get("guilds")
                .get(message.guild.id)
                .set("chargingChannel", message.channel.id)
                .write();
            message.channel.send(`Charging channel updated to <#${message.channel.id}>.`);
        }
    },

    forcePostImage: {
        helpText: "Force-post image",
        execute: function(message: MessageWithGuild): void {
            postImage();
        }
    },

    leaveVoice: {
        helpText: "Leave the voice channel",
        execute: function(message: MessageWithGuild): void {
            // tslint:disable-next-line:no-unused-expression
            message.guild.voice?.connection?.disconnect();
        }
    },

    reverb: {
        helpText: "Add reverb to your voice",
        execute: async function(message: MessageWithGuild): Promise<void> {
            ffmpegAudioCommand("reverb", message, ((baseCommand: FfmpegCommand) =>
                baseCommand.on("start", console.log)
                    .input(config.reverbKernel)
                    .input("anullsrc=channel_layout=stereo:sample_rate=44100")
                    .inputFormat("lavfi")
                    .inputOption(["-t", "3"])
                    .complexFilter([{
                        filter: "concat",
                        options: {
                            n: 2,
                            a: 1,
                            v: 0
                        },
                        inputs: [
                            "0:a",
                            "2:a"
                        ],
                        outputs: [
                            "concat_a"
                        ]
                    }, {
                        filter: "afir",
                        options: {
                            gtype: "gn"
                        },
                        inputs: [
                            "concat_a",
                            "1:a"
                        ],
                        outputs: [
                            "afir_a"
                        ]
                    }], ["afir_a"])
            ));
        }
    },

    wibbry: {
        helpText: "Repeat your voice with a wobbly audio filter",
        execute: async function(message: MessageWithGuild): Promise<void> {
            ffmpegAudioCommand("wibbry", message, ((baseCommand: FfmpegCommand) =>
                baseCommand.addOutputOption("-lavfi", "vibrato=f=4:d=1")
            ));
        }
    },

    lq: {
        helpText: "Repeat your voice with super-low quality",
        execute: async function(message: MessageWithGuild): Promise<void> {
            ffmpegAudioCommand("lq", message, ((baseCommand: FfmpegCommand) => {
                var passThrough: stream.PassThrough = new stream.PassThrough();
                baseCommand.on("start", console.log);
                baseCommand.format("mp3").audioCodec("libmp3lame").audioBitrate("8k").pipe(passThrough);
                var rtn: ffmpeg.FfmpegCommand = ffmpeg(passThrough).inputFormat("mp3");
                rtn.on("start", console.log);
                return rtn;
            }));
        }
    }

};

type FfmpegCommandTransformer = ((inputCommand: FfmpegCommand) => FfmpegCommand);

async function ffmpegAudioCommand(
        commandName: string,
        message: MessageWithGuild,
        effect: FfmpegCommandTransformer): Promise<void> {
    var member: GuildMember | undefined;
    if (message.mentions.members !== null) {
        member = message.mentions.members.first();
    }
    if (member === undefined && message.member !== null) {
        member = message.member;
    }
    if (member?.voice.channel) {
        var connection: VoiceConnection = await member.voice.channel?.join();
        var audio: stream.Readable = connection.receiver.createStream(member, { mode: "pcm", end: "silence" });
        var passThrough: stream.PassThrough = new stream.PassThrough();
        var timeout: schedule.Job = schedule.scheduleJob(moment().add(10, "second").toDate(), () => {
            message.channel.send("No audio received in 10 seconds - disconnecting.");
            connection.disconnect();
        });
        effect(ffmpeg().input(audio).inputFormat("s16le"))
            .format("s16le")
            .pipe(passThrough);
        connection.play(passThrough, { type: "converted" })
            .on("start", () => {
                console.log(`${commandName} - start`);
                timeout.cancel();
            })
            .on("finish", () => {
                console.log(`${commandName} - finish`);
                connection.disconnect();
            });
    } else {
        if (member === message.member) {
            message.channel.send("You need to join a voice channel first!");
        } else {
            message.channel.send("That user needs to join a voice channel first!");
        }
    }
}

client.on("message", message => {
    if (!(message instanceof Message) || message.guild === null) {
        return;
    } else if (message.content.startsWith(config.prefix)) {
        var firstSpace: number = message.content.indexOf(" ");
        var afterPrefix: string = message.content.slice(config.prefix.length, firstSpace > 0 ? firstSpace : undefined);
        if (commands.hasOwnProperty(afterPrefix)) {
            commands[afterPrefix].execute(message as MessageWithGuild);
        }
        console.log(message.content);
    } else if (message.content === config.entryMessage) {
        var chargingChannel: Snowflake = db.get("guilds")
            .get(message.guild.id)
            .get("chargingChannel")
            .value();
        if (message.channel.id === chargingChannel) {
            var chargingImageStart: Date | null = db.get("guilds")
                .get(message.guild.id)
                .get("chargingImageStart")
                .value();
            if (chargingImageStart !== null) {
                var cutoffTime: Moment = moment(chargingImageStart).add(config.entryDurationSeconds, "seconds");
                if (moment().isBefore(cutoffTime)) {
                    db.get("guilds")
                        .get(message.guild.id)
                        .get("chargedUsers")
                        .push(message.author.id)
                        .write();
                }
            }
        }
    }
});

function registerGuild(guild: Guild): void {
    if (!db.get("guilds").has(guild.id).value()) {
        console.log(`Writing guild ID ${guild.id}`);
        db.get("guilds")
            .set(guild.id, DefaultGuild())
            .write();
    } else {
        console.log(`Already have guild ID ${guild.id}`);
    }
}

function postImage(): void {
    var guilds: {[key: string]: GuildSchema} = db.get("guilds").value();
    Object.entries(guilds).forEach(([guildId, schema]: [Snowflake, GuildSchema]) => {
        if (schema.chargingChannel !== null) {
            var guild: Guild | undefined = client.guilds.get(guildId);
            if (guild !== undefined) {
                var channel: Channel | undefined = guild.channels.get(schema.chargingChannel);
                if (channel instanceof TextChannel) {
                    channel.send(new MessageAttachment(config.image)).then(() => {
                        db.get("guilds")
                            .get(guildId)
                            .assign({
                                chargingImageStart: moment().toDate(),
                                chargedUsers: []
                            })
                            .write();
                        var endTime: Moment = moment().add(config.entryDurationSeconds, "seconds");
                        console.log("Scheduled entry tallying for " + endTime.toISOString());
                        schedule.scheduleJob(endTime.toDate(), tallyEntries);
                    });
                }
            }
        }
    });
}

function tallyEntries(): void {
    var guilds: {[key: string]: GuildSchema} = db.get("guilds").value();
    Object.entries(guilds).forEach(([guildId, schema]: [Snowflake, GuildSchema]) => {
        if (schema.chargingChannel !== null) {
            var guild: Guild | undefined = client.guilds.get(guildId);
            if (guild !== undefined) {
                var channel: Channel | undefined = guild.channels.get(schema.chargingChannel);
                if (channel instanceof TextChannel) {
                    if (schema.chargedUsers !== null) {
                        var chargedUserset: Set<Snowflake> = new Set(schema.chargedUsers);
                        chargedUserset.forEach((userId: Snowflake) => {
                            db.get("guilds")
                                .get(guildId)
                                .get("scoreboard")
                                .defaults({[userId]: {score: config.scoreInitial}})
                                .get(userId)
                                .update("score", (score: number) => score + config.scoreEntryIncrement)
                                .write();
                        });
                        if (chargedUserset.size > 1) {
                            channel.send(`**${chargedUserset.size} users** have increased their charging speed!`);
                        } else if (chargedUserset.size === 1) {
                            channel.send(`**${chargedUserset.size} user** has increased their charging speed!`);
                        } else {
                            channel.send("No one wanted fast charging today...");
                        }
                        db.get("guilds")
                            .get(guildId)
                            .assign({
                                chargingImageStart: null,
                                chargedUsers: null
                            })
                            .write();
                    }
                }
            }
        }
    });
    schedulePost(moment().add(1, "day"));
}

function schedulePost(postDate: Moment): void {
    var imageWindowStartTime: Moment = moment(config.imageWindowStartTime, "HH:mmZ");
    var imageWindowStartDateTime: Moment = postDate.set({
        "hour": imageWindowStartTime.get("hour"),
        "minute": imageWindowStartTime.get("minute"),
        "second": 0,
        "millisecond": 0,
    });
    var randomOffsetMinutes: number = Math.floor(Math.random() * config.imageWindowDurationMinutes);
    var postImageTime: Moment = imageWindowStartDateTime.add(randomOffsetMinutes, "minutes");

    if (postImageTime.isAfter(moment())) {
        console.log("Scheduled image post for " + postImageTime.toISOString());
        schedule.scheduleJob(postImageTime.toDate(), postImage);
    } else {
        console.log("Couldn't schedule image post for " + postImageTime.toISOString() + " because it's in the past. Trying tomorrow...");
        schedulePost(postDate.add(1, "day"));
    }
}

schedulePost(moment());