import { Client, Message, Guild, TextChannel, Snowflake, Channel, VoiceConnection, GuildMember, MessageAttachment, User } from "discord.js";
import config from "./config.json";
import low from "lowdb";
import FileSync from "lowdb/adapters/FileSync";
import moment, { Moment } from "moment";
import schedule from "node-schedule";
import stream from "stream";
import fs from "fs";
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";

type UserSchema = {
    battery: number,
    chargingSpeed: number,
    chargingTick: schedule.Job | null,
};

const DefaultUser: (() => UserSchema) = () => ({
    battery: 1.0,
    chargingSpeed: 3,
    chargingTick: null,
});

type UsersSchema = {
    [key: string]: UserSchema // userId
};

const DefaultUsers: (() => UsersSchema) = () => ({});

type GuildSchema = {
    chargingChannel: Snowflake | null, // channelId
    chargingImageStart: Date | null,
    chargedUsers: Snowflake[] | null, // userId[]
    users: UsersSchema
};

const DefaultGuild: (() => GuildSchema) = () => ({
    chargingChannel: null,
    chargingImageStart: null,
    chargedUsers: null,
    users: DefaultUsers(),
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

db.get("guilds").forEach((_: GuildSchema, guildId: Snowflake) => {
    console.log("Clearing chargingTick for guild " + guildId);
    db.get(["guilds", guildId, "users"]).forEach((_: UserSchema, userId: Snowflake) => {
        console.log("Clearing chargingTick for user " + userId);
        db.get(["guilds", guildId, "users", userId])
            .set("chargingTick", null)
            .value();
    }).value();
}).value();
db.write();

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
    batteryCost: number,
    execute: (message: MessageWithGuild) => Promise<number>
};

const commands: {[key: string]: Command} = {
    help: {
        helpText: "View this information",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            var allHelpText: string[] = [];
            Object.entries(commands).forEach(([commandName, command]: [string, Command]) => {
                allHelpText.push(`${config.prefix}${commandName} - ${command.helpText}`);
            });
            message.channel.send(allHelpText.join("\n"));
            return 1;
        }
    },

    scoreboard: {
        helpText: "View the charging speed scoreboard for this server",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            var users: UsersSchema = db.get("guilds")
                .get(message.guild.id)
                .get("users", {})
                .value();
            type UserScore = {userId: Snowflake, score: number};
            var scoreArray: UserScore[] = Object.keys(users)
                .map((userId: Snowflake) => ({
                    userId: userId,
                    score: users[userId].chargingSpeed
                }));
            scoreArray.sort(userScore => userScore.score);
            var scoreMessageArray: string[] = [];
            scoreArray.forEach(userScore => {
                var user: GuildMember | undefined = message.guild.members.get(userScore.userId);
                var userDisplayName: string = (user === undefined) ? userScore.userId.toString() : user.displayName;
                scoreMessageArray.push("**" + userDisplayName + "**: " + userScore.score + config.scoreSuffix);
            });
            message.channel.send("Scoreboard:\n" + scoreMessageArray.join("\n"));
            return 1;
        }
    },

    status: {
        helpText: "View your battery level and charging speed",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            var user: UserSchema = db.get("guilds")
                .get(message.guild.id)
                .get("users")
                .defaults({[message.author.id]: DefaultUser()})
                .get(message.author.id)
                .value();
            var displayBattery: string = Math.floor(user.battery * 100) + "%";
            var displayChargingSpeed: string = user.chargingSpeed + config.scoreSuffix;
            var displayCharging: string = user.chargingTick !== null ? " (charging)" : ""
            message.channel.send(`<@${message.author.id}> Your battery is at **${displayBattery}**${displayCharging} and your charging speed is **${displayChargingSpeed}**.`);
            return 1;
        }
    },

    charge: {
        helpText: "Charge your battery",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            var user: UserSchema = db.get("guilds")
                .get(message.guild.id)
                .get("users")
                .get(message.author.id)
                .value();
            if (user.chargingTick !== null) {
                message.channel.send("You're already charging!");
            } else if (user.battery >= 1) {
                message.channel.send("Your battery is already full!");
            } else {
                var currentlyCharging: number = db.get("guilds")
                    .get(message.guild.id)
                    .get("users")
                    .map((user: UserSchema) => user.chargingTick)
                    .filter((chargingTick: schedule.Job | null) => chargingTick !== null)
                    .size()
                    .value();
                if (currentlyCharging >= 2) { // todo: per-guild config of charging port count
                    message.channel.send("Sorry, all the charging ports are currently in use.");
                } else {
                    var secondsToFull: number = (1 - user.battery) * 100 * (900 / user.chargingSpeed);
                    var minutesToFull: number = secondsToFull / 60;
                    var hoursToFull: number = minutesToFull / 60;
                    var timeToFullDisplay: string;
                    if (hoursToFull > 0) {
                        timeToFullDisplay = hoursToFull.toFixed(1) + " hours";
                    } else if (minutesToFull > 0) {
                        timeToFullDisplay = minutesToFull.toFixed(0) + " minutes";
                    } else {
                        timeToFullDisplay = secondsToFull.toFixed(0) + " seconds";
                    }
                    message.channel.send(`You're plugged in now. It'll take about **${timeToFullDisplay}** to fully charge.`);
                    scheduleChargeTick(message.guild.id, message.author.id);
                }
            }
            return 1;
        }
    },

    unplug: {
        helpText: "Stop charging your battery",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            var user: UserSchema = db.get("guilds")
                .get(message.guild.id)
                .get("users")
                .get(message.author.id)
                .value();
            if (user.chargingTick === null) {
                message.channel.send("You're not charging right now.");
            } else {
                db.get(["guilds", message.guild.id, "users", message.author.id])
                    .set("chargingTick", null)
                    .write();
                var batteryDisplay: string = Math.floor(user.battery * 100) + "%";
                message.channel.send(`Unplugged. Your battery is at **${batteryDisplay}**.`);
            }
            return 1;
        }
    },

    setChargingChannel: {
        helpText: "Set the channel for charging to the channel where the command was sent",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            db.get("guilds")
                .get(message.guild.id)
                .set("chargingChannel", message.channel.id)
                .write();
            message.channel.send(`Charging channel updated to <#${message.channel.id}>.`);
            return 1;
        }
    },

    forcePostImage: {
        helpText: "Force-post image",
        batteryCost: 1.0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            postImage();
            return 1;
        }
    },

    leaveVoice: {
        helpText: "Leave the voice channel",
        batteryCost: 0,
        execute: async function(message: MessageWithGuild): Promise<number> {
            // tslint:disable-next-line:no-unused-expression
            message.guild.voice?.connection?.disconnect();
            return 1;
        }
    },

    reverb: {
        helpText: "Add reverb to your voice",
        batteryCost: 0.15,
        execute: async function(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("reverb", message, ((baseCommand: FfmpegCommand) =>
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
        batteryCost: 0.15,
        execute: async function(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("wibbry", message, ((baseCommand: FfmpegCommand) =>
                baseCommand.complexFilter([
                    {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1
                        },
                        outputs: ["v1"],
                    }, {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1
                        },
                        inputs: ["v1"],
                        outputs: ["v2"],
                    }, {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1
                        },
                        inputs: ["v2"],
                        outputs: ["v3"],
                    }
                ], "v3")
            ));
        }
    },

    lq: {
        helpText: "Repeat your voice with super-low quality",
        batteryCost: 0.15,
        execute: async function(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("lq", message, ((baseCommand: FfmpegCommand) => {
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
        effect: FfmpegCommandTransformer): Promise<number> {
    var maybeMember: GuildMember | undefined;
    if (message.mentions.members !== null) {
        maybeMember = message.mentions.members.first();
    }
    if (maybeMember === undefined && message.member !== null) {
        maybeMember = message.member;
    }
    if (maybeMember?.voice.channel) {
        var member: GuildMember = maybeMember;
        var connection: VoiceConnection = await maybeMember.voice.channel?.join();
        return new Promise<number>((resolve, reject): void => {
            var audio: stream.Readable = connection.receiver.createStream(member, { mode: "pcm", end: "silence" });
            var passThrough: stream.PassThrough = new stream.PassThrough();
            var timeout: schedule.Job = schedule.scheduleJob(moment().add(10, "second").toDate(), () => {
                message.channel.send("No audio received in 10 seconds - disconnecting.");
                connection.disconnect();
                resolve(0);
            });
            effect(ffmpeg().input(audio).inputFormat("s16le"))
                .format("s16le")
                .pipe(passThrough);
            connection.play(passThrough, { type: "converted" })
                .on("start", () => {
                    console.log(`${commandName} - start`);
                    timeout.cancel();
                    resolve(1);
                })
                .on("finish", () => {
                    console.log(`${commandName} - finish`);
                    connection.disconnect();
                });
        });
    } else {
        if (maybeMember === message.member) {
            message.channel.send("You need to join a voice channel first!");
            return 0;
        } else {
            message.channel.send("That user needs to join a voice channel first!");
            return 0;
        }
    }
}

client.on("message", message_ => {
    if (!(message_ instanceof Message) || message_.guild === null || message_.author.bot) {
        return;
    }
    var message: MessageWithGuild = message_ as MessageWithGuild;
    if (message.content.startsWith(config.prefix)) {
        var firstSpace: number = message.content.indexOf(" ");
        var afterPrefix: string = message.content.slice(config.prefix.length, firstSpace > 0 ? firstSpace : undefined);
        if (commands.hasOwnProperty(afterPrefix)) {
            var batteryCost: number = commands[afterPrefix].batteryCost;
            var userBattery: number = db.get("guilds")
                .get(message.guild.id)
                .get("users")
                .defaults({[message.author.id]: DefaultUser()})
                .get(message.author.id)
                .get("battery")
                .value();
            if (batteryCost <= userBattery) {
                commands[afterPrefix].execute(message).then((batteryCostWeight: number) => {
                    var batteryCostWeighted: number = batteryCostWeight * batteryCost;
                    if (batteryCostWeighted > 0) {
                        db.get("guilds")
                            .get(message.guild.id)
                            .get("users")
                            .get(message.author.id)
                            .update("battery", (battery: number) => Math.max(0, battery - batteryCostWeighted))
                            .write();
                    }
                });
            } else {
                message.channel.send(`You don't have enough battery power! Charge your battery using the **${config.prefix}charge** command.`);
            }
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

function scheduleChargeTick(guildId: Snowflake, userId: Snowflake): void {
    var user: UserSchema = db.get(["guilds", guildId, "users", userId]).value();
    var chargingTickSeconds: number = 900 / user.chargingSpeed;
    var nextCharge: Date = moment().add(chargingTickSeconds, "second").toDate();
    console.log(`Guild ${guildId} / user ${userId}'s next charge tick is at ${nextCharge.toISOString()}`);
    db.get(["guilds", guildId, "users", userId])
        .set("chargingTick", schedule.scheduleJob(nextCharge, () => {
            db.get(["guilds", guildId, "users", userId])
                .update("battery", (battery: number) => Math.min(1, battery + 0.01))
                .write();
            if (db.get(["guilds", guildId, "users", userId, "battery"]).value() === 1) {
                db.get(["guilds", guildId, "users", userId])
                    .set("chargingTick", null)
                    .write();
                console.log(`Guild ${guildId} / user ${userId} is fully charged`);
            } else {
                scheduleChargeTick(guildId, userId);
            }
        }))
        .write();
}

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
                } else {
                    console.log(`Charging channel for guild ${guildId} is not a TextChannel`);
                }
            } else {
                console.log(`Client doesn't know about guild ${guildId}`);
            }
        } else {
            console.log(`No charging channel set for guild ${guildId}`);
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
                        var chargedUserSet: Set<Snowflake> = new Set(schema.chargedUsers);
                        chargedUserSet.forEach((userId: Snowflake) => {
                            db.get("guilds")
                                .get(guildId)
                                .get("users")
                                .defaults({[userId]: DefaultUser()})
                                .get(userId)
                                .update("chargingSpeed", (score: number) => score + config.scoreEntryIncrement)
                                .value(); // execute but do not write using .value()
                        });
                        db.write(); // write all chargingSpeed updates at the end
                        if (chargedUserSet.size > 1) {
                            channel.send(`**${chargedUserSet.size} users** have increased their charging speed!`);
                        } else if (chargedUserSet.size === 1) {
                            channel.send(`**${chargedUserSet.size} user** has increased their charging speed!`);
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
                    } else {
                        console.log(`chargedUsers for guild ${guildId} is null`);
                    }
                } else {
                    console.log(`Charging channel for guild ${guildId} is not a TextChannel`);
                }
            } else {
                console.log(`Client doesn't know about guild ${guildId}`);
            }
        } else {
            console.log(`No charging channel set for guild ${guildId}`);
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