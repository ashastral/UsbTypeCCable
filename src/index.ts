import { Channel, Client, Guild, GuildMember, Message, MessageAttachment, Snowflake, TextChannel, VoiceConnection } from "discord.js";
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";
import moment, { Moment } from "moment";
import schedule from "node-schedule";
import stream from "stream";
import config from "../config.json";
import { GuildConfigState, GuildState, PersistentAppState, TransientAppState, TransientGuildState,
         TransientUserState, UsersState, UserState } from "./state";

type MessageWithGuild = { guild: Guild } & Message;

const PS: PersistentAppState = new PersistentAppState("db/state.json");
const TS: TransientAppState = new TransientAppState();

const client: Client = new Client();

client.once("ready", () => {
    client.guilds.forEach((guild: Guild) => {
        registerGuild(guild);
    });
    if (client.user !== null) {
        client.user.setActivity(`${config.prefix}help`, {type: "PLAYING"});
    }
    console.log("Ready!");
});

client.on("guildCreate", registerGuild);

client.login(config.token);

interface Command {
    batteryCost?: number;
    helpText: string;
    helpDetails?: string;
    adminOnly?: boolean;
    run: (message: MessageWithGuild) => Promise<number>;
}

const commands: {[key: string]: Command} = {
    help: {
        helpText: "View this information",
        async run(message: MessageWithGuild): Promise<number> {
            const allHelpText: string[] = [];
            Object.entries(commands).forEach(([commandName, command]: [string, Command]) => {
                if (command.adminOnly) {
                    return;
                }
                let cost: string = "";
                if (command.batteryCost !== undefined) {
                    cost = " (-" + (command.batteryCost * 100).toFixed(0) + "%)";
                }
                allHelpText.push(`${config.prefix}${commandName}${cost} - ${command.helpText}`);
            });
            message.channel.send(allHelpText.join("\n"));
            return 1;
        },
    },

    scoreboard: {
        helpText: "View the charging speed scoreboard for this server",
        async run(message: MessageWithGuild): Promise<number> {
            const users: UsersState<UserState> = PS.guild(message.guild.id).users;
            interface UserScore { userId: Snowflake; score: number; }
            const scoreArray: UserScore[] = Object.entries(users)
                .map(([userId, user]: [Snowflake, UserState]) => ({
                    userId,
                    score: user.chargingSpeed,
                }));
            scoreArray.sort((a: UserScore, b: UserScore) => a.score - b.score);
            const scoreMessageArray: string[] = [];
            scoreArray.forEach((userScore) => {
                const user: GuildMember | undefined = message.guild.members.get(userScore.userId);
                const userDisplayName: string = (user === undefined) ? userScore.userId.toString() : user.displayName;
                scoreMessageArray.push("**" + userDisplayName + "**: " + userScore.score + config.scoreSuffix);
            });
            message.channel.send("Scoreboard:\n" + scoreMessageArray.join("\n"));
            return 1;
        },
    },

    status: {
        helpText: "View your battery level and charging speed",
        async run(message: MessageWithGuild): Promise<number> {
            const user: UserState = PS.user(message.guild.id, message.author.id);
            const transientUser: TransientUserState = TS.user(message.guild.id, message.author.id);
            const displayBattery: string = Math.floor(user.battery * 100) + "%";
            const displayChargingSpeed: string = user.chargingSpeed + config.scoreSuffix;
            const displayCharging: string = transientUser.chargingJob !== null ? " (charging)" : "";
            message.channel.send(`<@${message.author.id}> Your battery is at **${displayBattery}**${displayCharging} and your charging speed is **${displayChargingSpeed}**.`);
            return 1;
        },
    },

    charge: {
        helpText: "Charge your battery",
        async run(message: MessageWithGuild): Promise<number> {
            const user: UserState = PS.user(message.guild.id, message.author.id);
            const transientUser: TransientUserState = TS.user(message.guild.id, message.author.id);
            if (transientUser.chargingJob !== null) {
                message.channel.send("You're already charging!");
            } else if (user.battery >= 1) {
                message.channel.send("Your battery is already full!");
            } else {
                const currentlyCharging: number = Object.values(TS.guild(message.guild.id).users)
                    .map((someUser: TransientUserState) => someUser.chargingJob)
                    .filter((chargingJob: schedule.Job | null) => chargingJob !== null)
                    .length;
                if (currentlyCharging >= 2) { // todo: per-guild config of charging port count
                    message.channel.send("Sorry, all the charging ports are currently in use.");
                } else {
                    const secondsToFull: number = (1 - user.battery) * 100 * (900 / user.chargingSpeed);
                    const minutesToFull: number = secondsToFull / 60;
                    const hoursToFull: number = minutesToFull / 60;
                    let timeToFullDisplay: string;
                    if (hoursToFull >= 1) {
                        timeToFullDisplay = hoursToFull.toFixed(1) + " hours";
                    } else if (minutesToFull >= 1) {
                        timeToFullDisplay = minutesToFull.toFixed(0) + " minutes";
                    } else {
                        timeToFullDisplay = secondsToFull.toFixed(0) + " seconds";
                    }
                    message.channel.send(`You're plugged in now. It'll take about **${timeToFullDisplay}** to fully charge.`);
                    scheduleChargeJob(message.guild.id, message.author.id);
                }
            }
            return 1;
        },
    },

    unplug: {
        helpText: "Stop charging your battery",
        async run(message: MessageWithGuild): Promise<number> {
            const user: UserState = PS.user(message.guild.id, message.author.id);
            const transientUser: TransientUserState = TS.user(message.guild.id, message.author.id);
            if (transientUser.chargingJob === null) {
                message.channel.send("You're not charging right now.");
            } else {
                transientUser.chargingJob.cancel();
                transientUser.chargingJob = null;
                PS.save();
                const batteryDisplay: string = Math.floor(user.battery * 100) + "%";
                message.channel.send(`Unplugged. Your battery is at **${batteryDisplay}**.`);
            }
            return 1;
        },
    },

    config: {
        adminOnly: true,
        helpText: "Configure this server's settings",
        helpDetails: [
            `Configure this server's settings. Syntax: **${config.prefix}config key value**. Keys:`,
            "> **chargingChannel** - Home channel for 'Type C' images",
            "> **typeCWindowStartTime** - Start of the daily window for 'Type C' (HH:MMZ)",
            "> **typeCWindowDurationMinutes** - Size of the daily window for 'Type C'",
            "> **typeCEntryDurationSeconds** - How long users have to respond to 'Type C'",
            "> **prefixOverride** - Not implemented",
            "> **typeCImageOverride** - Not implemented",
            "> **typeCEntryMessageOverride** - Not implemented",
            "> **scoreInitialOverride** - Not implemented",
            "> **scoreEntryIncrementOverride** - Not implemented",
            "> **scoreSuffixOverride** - Not implemented",
        ].join("\n"),
        async run(message: MessageWithGuild): Promise<number> {
            const words: string[] = message.content.split(" ");
            const guildConfig: GuildConfigState = PS.guild(message.guild.id).config;
            if (words.length > 2) {
                const configKey: string = words[1];
                if (configKey === "chargingChannel") {
                    const channel: TextChannel | undefined = message.mentions.channels.first();
                    if (channel !== undefined) {
                        guildConfig.chargingChannel = channel.id;
                        message.channel.send(`Charging channel updated to <#${channel.id}>.`);
                        PS.save();
                    } else {
                        message.channel.send("Missing channel parameter.");
                    }
                } else if (configKey === "typeCWindowStartTime") {
                    guildConfig.typeCWindowStartTime = words[2];
                    message.channel.send(`'Type C' window start time updated to ${words[2]}.`);
                    PS.save();
                } else if (configKey === "typeCWindowDurationMinutes") {
                    const windowDurationMinutes: number = parseInt(words[2], 10);
                    if (windowDurationMinutes >= 1 && windowDurationMinutes <= 1440) {
                        guildConfig.typeCWindowDurationMinutes = windowDurationMinutes;
                        message.channel.send(`'Type C' window duration updated to ${windowDurationMinutes} minutes.`);
                        PS.save();
                    } else {
                        message.channel.send(`Value parameter should be a number of minutes between 1 and 1440.`);
                    }
                } else if (configKey === "typeCEntryDurationSeconds") {
                    const entryDurationSeconds: number = parseInt(words[2], 10);
                    if (entryDurationSeconds >= 1 && entryDurationSeconds <= 3600) {
                        guildConfig.typeCEntryDurationSeconds = entryDurationSeconds;
                        message.channel.send(`'Type C' entry duration updated to ${entryDurationSeconds} seconds.`);
                        PS.save();
                    } else {
                        message.channel.send(`Value parameter should be a number of seconds between 1 and 3600.`);
                    }
                } else {
                    message.channel.send("Unknown or unimplemented config key.");
                }
            } else if (words.length === 2) {
                const key: string = words[1];
                if (guildConfig.hasOwnProperty(key)) {
                    let value: string = (guildConfig as any)[key];
                    if (key === "chargingChannel") {
                        value = "<#" + value + ">";
                    }
                    message.channel.send(`**${key}** is currently set to **${value}**.`);
                } else {
                    message.channel.send(`Unknown config key. Type **${config.prefix}config** by itself for help.`);
                }
            } else {
                message.channel.send(commands.config.helpDetails);
            }
            return 1;
        },
    },

    admin: {
        adminOnly: true,
        helpText: "Administrative commands",
        helpDetails: [
            `Administrative commands for this server. Syntax: **${config.prefix}admin command**. Commands:`,
            "> **forceTypeC** - Post the 'Type C' image immediately.",
            "> **rescheduleTypeC** - Reschedule the next 'Type C' post.",
            "> **forceTallyEntries** - Tally entries for the active 'Type C' post immediately.",
            "> **leaveVoice** - Leave the voice channel.",
        ].join("\n"),
        async run(message: MessageWithGuild): Promise<number> {
            const words: string[] = message.content.split(" ");
            if (words.length === 2) {
                const command: string = words[1];
                if (command === "forceTypeC") {
                    postImage(message.guild.id);
                    message.channel.send("Done.");
                } else if (command === "rescheduleTypeC") {
                    schedulePost(message.guild.id, moment());
                    message.channel.send("Done.");
                } else if (command === "forceTallyEntries") {
                    const transientGuild: TransientGuildState = TS.guild(message.guild.id);
                    if (transientGuild.typeCTallyJob === null) {
                        message.channel.send("No entry tallying job scheduled currently.");
                    } else {
                        transientGuild.typeCTallyJob.invoke();
                        message.channel.send("Done.");
                    }
                } else if (command === "leaveVoice") {
                    message.guild.voice?.connection?.disconnect();
                    message.channel.send("Done.");
                } else {
                    message.channel.send(`Unknown admin command. Type **${config.prefix}admin** by itself for help.`);
                }
            } else if (words.length === 1) {
                message.channel.send(commands.admin.helpDetails);
            } else {
                message.channel.send("Wrong parameter count.");
            }
            return 1;
        },
    },

    reverb: {
        batteryCost: 0.15,
        helpText: "Add reverb to your voice",
        async run(message: MessageWithGuild): Promise<number> {
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
                            v: 0,
                        },
                        inputs: [
                            "0:a",
                            "2:a",
                        ],
                        outputs: [
                            "concat_a",
                        ],
                    }, {
                        filter: "afir",
                        options: {
                            gtype: "gn",
                        },
                        inputs: [
                            "concat_a",
                            "1:a",
                        ],
                        outputs: [
                            "afir_a",
                        ],
                    }], ["afir_a"])
            ));
        },
    },

    wibbry: {
        batteryCost: 0.15,
        helpText: "Repeat your voice with a wobbly audio filter",
        async run(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("wibbry", message, ((baseCommand: FfmpegCommand) =>
                baseCommand.complexFilter([
                    {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1,
                        },
                        outputs: ["v1"],
                    }, {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1,
                        },
                        inputs: ["v1"],
                        outputs: ["v2"],
                    }, {
                        filter: "vibrato",
                        options: {
                            f: 4,
                            d: 1,
                        },
                        inputs: ["v2"],
                        outputs: ["v3"],
                    },
                ], "v3")
            ));
        },
    },

    chipmunk: {
        batteryCost: 0.15,
        helpText: "Repeat your voice pitched up an octave",
        async run(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("chipmunk", message, ((baseCommand: FfmpegCommand) => {
                baseCommand.on("start", console.log);
                return baseCommand.audioFilters(["asetrate=96000,aresample=48000,atempo=0.5"]);
            }));
        },
    },

};

type FfmpegCommandTransformer = ((inputCommand: FfmpegCommand) => FfmpegCommand);

async function ffmpegAudioCommand(
        commandName: string,
        message: MessageWithGuild,
        effect: FfmpegCommandTransformer): Promise<number> {
    let maybeMember: GuildMember | undefined;
    if (message.mentions.members !== null) {
        maybeMember = message.mentions.members.first();
    }
    if (maybeMember === undefined && message.member !== null) {
        maybeMember = message.member;
    }
    if (maybeMember?.voice.channel) {
        const member: GuildMember = maybeMember;
        const connection: VoiceConnection = await maybeMember.voice.channel?.join();
        return new Promise<number>((resolve): void => {
            const audio: stream.Readable = connection.receiver.createStream(member, { mode: "pcm", end: "silence" });
            const passThrough: stream.PassThrough = new stream.PassThrough();
            const timeout: schedule.Job = schedule.scheduleJob(moment().add(10, "second").toDate(), () => {
                message.channel.send("No audio received in 10 seconds - disconnecting.");
                connection.disconnect();
                resolve(0.2); // minor penalty to discourage spamming
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

client.on("message", (incomingMessage) => {
    if (!(incomingMessage instanceof Message) || incomingMessage.guild === null || incomingMessage.author.bot) {
        return;
    }
    const message: MessageWithGuild = incomingMessage as MessageWithGuild;
    if (message.content.startsWith(config.prefix)) {
        let firstSpace: number | undefined = message.content.indexOf(" ");
        firstSpace = firstSpace > 0 ? firstSpace : undefined;
        const afterPrefix: string = message.content.slice(config.prefix.length, firstSpace);
        if (commands.hasOwnProperty(afterPrefix)) {
            const command: Command = commands[afterPrefix];
            const batteryCost: number = command.batteryCost ?? 0;
            if (command.adminOnly && message.author.id !== config.adminUser) {
                message.channel.send("This command is restricted to the bot's administrator.");
                return;
            }
            const user: UserState = PS.user(message.guild.id, message.author.id);
            if (batteryCost <= user.battery) {
                command.run(message).then((batteryCostWeight: number) => {
                    console.log(`batteryCostWeight = ${batteryCostWeight}`);
                    const batteryCostWeighted: number = batteryCostWeight * batteryCost;
                    if (batteryCostWeighted > 0) {
                        user.battery = Math.max(0, user.battery - batteryCostWeighted);
                        const transientUser: TransientUserState = TS.user(message.guild.id, message.author.id);
                        if (transientUser.chargingJob !== null) {
                            transientUser.chargingJob.cancel();
                            transientUser.chargingJob = null;
                            message.channel.send(`<@${message.author.id}> You've been automatically unplugged to run this command.`);
                        }
                        PS.save();
                    }
                });
            } else {
                message.channel.send(`You don't have enough battery power! Charge your battery using the **${config.prefix}charge** command.`);
            }
        }
        console.log(message.content);
    } else if (message.content === config.typeCEntryMessage) {
        const guild: GuildState = PS.guild(message.guild.id);
        const transientGuild: TransientGuildState = TS.guild(message.guild.id);
        if (message.channel.id === guild.config.chargingChannel) {
            if (transientGuild.typeCPostStart !== null && guild.config.typeCEntryDurationSeconds !== null) {
                const cutoffTime: Moment = moment(transientGuild.typeCPostStart)
                    .add(guild.config.typeCEntryDurationSeconds, "seconds");
                if (moment().isBefore(cutoffTime)) {
                    if (transientGuild.typeCChargedUsers === null) {
                        transientGuild.typeCChargedUsers = [];
                    }
                    transientGuild.typeCChargedUsers.push(message.author.id);
                    PS.save();
                }
            }
        }
    }
});

function scheduleChargeJob(guildId: Snowflake, userId: Snowflake): void {
    const user: UserState = PS.user(guildId, userId);
    const chargingTickSeconds: number = 900 / user.chargingSpeed;
    const nextCharge: Date = moment().add(chargingTickSeconds, "second").toDate();
    console.log(`Guild ${guildId} / user ${userId}'s next charge tick is at ${nextCharge.toISOString()}`);
    const transientUser: TransientUserState = TS.user(guildId, userId);
    transientUser.chargingJob = schedule.scheduleJob(nextCharge, () => {
        user.battery = Math.min(1, user.battery + 0.01);
        if (user.battery === 1) {
            transientUser.chargingJob = null;
            console.log(`Guild ${guildId} / user ${userId} is fully charged`);
        } else {
            scheduleChargeJob(guildId, userId);
        }
        PS.save();
    });
    PS.save();
}

function registerGuild(guild: Guild): void {
    const guildState: GuildState = PS.guild(guild.id);
    if (guildState.nextTypeCDate !== null) {
        const transientGuild: TransientGuildState = TS.guild(guild.id);
        if (transientGuild.nextTypeCJob !== null) {
            transientGuild.nextTypeCJob.cancel();
        }
        schedulePost(guild.id, moment());
    }
}

function postImage(guildId: Snowflake): void {
    const guildState: GuildState = PS.guild(guildId);
    const transientGuild: TransientGuildState = TS.guild(guildId);
    if (guildState.config.chargingChannel !== null) {
        const guild: Guild | undefined = client.guilds.get(guildId);
        if (guild !== undefined) {
            const channel: Channel | undefined = guild.channels.get(guildState.config.chargingChannel);
            if (channel instanceof TextChannel) {
                const typeCImage: string = guildState.config.typeCImageOverride || config.typeCImage;
                channel.send(new MessageAttachment(typeCImage)).then(() => {
                    transientGuild.typeCPostStart = moment().toDate();
                    transientGuild.typeCChargedUsers = [];
                    if (guildState.config.typeCEntryDurationSeconds !== null) { // should always be true
                        const endTime: Moment = moment().add(guildState.config.typeCEntryDurationSeconds, "seconds");
                        console.log("Scheduled entry tallying for " + endTime.toISOString());
                        transientGuild.typeCTallyJob = schedule.scheduleJob(endTime.toDate(), () => {
                            tallyEntries(guildId);
                            transientGuild.typeCTallyJob = null;
                        });
                    }
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
}

function tallyEntries(guildId: Snowflake): void {
    const guildState: GuildState = PS.guild(guildId);
    const transientGuild: TransientGuildState = TS.guild(guildId);
    if (guildState.config.chargingChannel !== null) {
        const guild: Guild | undefined = client.guilds.get(guildId);
        if (guild !== undefined) {
            const channel: Channel | undefined = guild.channels.get(guildState.config.chargingChannel);
            if (channel instanceof TextChannel) {
                if (transientGuild.typeCChargedUsers !== null) {
                    const chargedUserSet: Set<Snowflake> = new Set(transientGuild.typeCChargedUsers);
                    chargedUserSet.forEach((userId: Snowflake) => {
                        PS.user(guildId, userId).chargingSpeed += config.scoreEntryIncrement;
                    });
                    if (chargedUserSet.size > 1) {
                        channel.send(`**${chargedUserSet.size} users** have increased their charging speed!`);
                    } else if (chargedUserSet.size === 1) {
                        channel.send(`**${chargedUserSet.size} user** has increased their charging speed!`);
                    } else {
                        channel.send("No one wanted fast charging today...");
                    }
                    transientGuild.typeCPostStart = null;
                    transientGuild.typeCChargedUsers = null;
                    PS.save();
                } else {
                    console.log(`typeCChargedUsers for guild ${guildId} is null`);
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
    schedulePost(guildId, moment().add(1, "day"));
}

function schedulePost(guildId: Snowflake, postDate: Moment): void {
    const guild: GuildState = PS.guild(guildId);
    const transientGuild: TransientGuildState = TS.guild(guildId);
    if (guild.config.typeCWindowStartTime === null
            || guild.config.typeCWindowDurationMinutes === null
            || guild.config.typeCEntryDurationSeconds === null) {
        console.log(`Couldn't schedule Type C for guild ${guildId} because it's not fully configured`);
    } else {
        const imageWindowStartTime: Moment = moment(guild.config.typeCWindowStartTime, "HH:mmZ");
        const imageWindowStartDateTime: Moment = postDate.set({
            hour: imageWindowStartTime.get("hour"),
            minute: imageWindowStartTime.get("minute"),
            second: 0,
            millisecond: 0,
        });
        const randomOffsetMinutes: number = Math.floor(Math.random() * guild.config.typeCWindowDurationMinutes);
        const postImageTime: Moment = imageWindowStartDateTime.add(randomOffsetMinutes, "minutes");

        if (postImageTime.isAfter(moment())) {
            guild.nextTypeCDate = postImageTime.toDate();
            transientGuild.nextTypeCJob = schedule.scheduleJob(postImageTime.toDate(), () => { postImage(guildId); });
            console.log("Scheduled image post for " + postImageTime.toISOString());
        } else {
            console.log(`Couldn't schedule image post for ${postImageTime.toISOString()} because it's in the past. Trying tomorrow...`);
            schedulePost(guildId, postDate.add(1, "day"));
        }
    }
}
