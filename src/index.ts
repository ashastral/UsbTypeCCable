import {
    Channel, Client, Guild, GuildMember, Intents, Message, MessageAttachment, Snowflake,
    TextChannel
} from "discord.js";
import { VoiceConnection } from "@discordjs/voice";
import ffmpeg, { FfmpegCommand } from "fluent-ffmpeg";
import moment, { Moment } from "moment";
import schedule from "node-schedule";
import stream from "stream";
import config from "../config.json";
import {
    GuildConfigState, GuildState, PersistentAppState, TransientAppState, TransientGuildState,
    TransientUserState, UsersState, UserState
} from "./state";

type MessageWithGuild = { guild: Guild } & Message;

const PS: PersistentAppState = new PersistentAppState("db/state.json");
const TS: TransientAppState = new TransientAppState();

const client: Client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.GUILD_MESSAGES,
    ],
});

client.once("ready", () => {
    client.guilds.cache.forEach((guild: Guild) => {
        registerGuild(guild);
    });
    if (client.user !== null) {
        client.user.setActivity(`${config.prefix}help`, { type: "PLAYING" });
    }
    console.log("Ready!");
});

client.on("guildCreate", registerGuild);

client.login(config.token);

interface Command {
    batteryCost?: number;
    scoreCost?: number;
    helpText: string;
    helpDetails?: string;
    adminOnly?: boolean;
    run: (message: MessageWithGuild) => Promise<number>;
}

const commands: { [key: string]: Command } = {
    help: {
        helpText: "Learn the basics of the bot",
        async run(message: MessageWithGuild): Promise<number> {
            const chargingChannel: string | null = PS.guild(message.guild.id).config.chargingChannel;
            let chargingChannelDisplay: string;
            if (chargingChannel !== null) {
                chargingChannelDisplay = "<#" + chargingChannel + ">";
            } else {
                chargingChannelDisplay = "(oops, no chargingChannel set for this server)";
            }
            message.channel.send([
                `I'm **${client.user?.username}**! I have some funny commands you can run (use **${config.prefix}commands** to learn more).`,
                `Some commands cost "battery power" to run. You'll need to recharge your battery using **${config.prefix}charge** if you run out.`,
                `To increase your charging speed, follow the instructions on the image I post in ${chargingChannelDisplay} at a random time each day.`,
            ].join("\n"));
            return 1;
        },
    },

    commands: {
        helpText: "View this information",
        async run(message: MessageWithGuild): Promise<number> {
            const allHelpText: string[] = ["User commands:"];
            Object.entries(commands).forEach(([commandName, command]: [string, Command]) => {
                if (command.adminOnly) {
                    return;
                }
                let cost: string = "";
                if (command.batteryCost !== undefined) {
                    cost += " (-" + (command.batteryCost * 100).toFixed(0) + "%)";
                }
                if (command.scoreCost !== undefined) {
                    cost += " **(-" + command.scoreCost + " W)**";
                }
                allHelpText.push(`> **${config.prefix}${commandName}**${cost} - ${command.helpText}`);
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
            scoreArray.sort((a: UserScore, b: UserScore) => b.score - a.score); // highest to lowest
            const scoreMessageArray: string[] = ["Charging speed scoreboard:"];
            const members = await message.guild.members.fetch();
            scoreArray.forEach(async (userScore) => {
                const user: GuildMember | undefined = members.get(userScore.userId);
                const userDisplayName: string = (user === undefined) ? userScore.userId.toString() : user.displayName;
                scoreMessageArray.push("> **" + userDisplayName + "** - " + userScore.score + config.scoreSuffix);
            });
            message.channel.send(scoreMessageArray.join("\n"));
            return 1;
        },
    },

    leaderboard: {
        helpText: 'alias for scoreboard',
        async run(message: MessageWithGuild): Promise<number> {
            return commands.scoreboard.run(message);
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
                message.channel.send(`<@${message.author.id}> You're already charging!`);
            } else if (user.battery >= 1) {
                message.channel.send(`<@${message.author.id}> Your battery is already full!`);
            } else {
                const currentlyCharging: number = Object.values(TS.guild(message.guild.id).users)
                    .map((someUser: TransientUserState) => someUser.chargingJob)
                    .filter((chargingJob: schedule.Job | null) => chargingJob !== null)
                    .length;
                if (currentlyCharging >= 2) { // todo: per-guild config of charging port count
                    message.channel.send(`<@${message.author.id}> Sorry, all the charging ports are currently in use.`);
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
                    message.channel.send(`<@${message.author.id}> You're plugged in now. It'll take about **${timeToFullDisplay}** to fully charge.`);
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
                message.channel.send(`<@${message.author.id}> You're not charging right now.`);
            } else {
                transientUser.chargingJob.cancel();
                transientUser.chargingJob = null;
                const batteryDisplay: string = Math.floor(user.battery * 100) + "%";
                message.channel.send(`<@${message.author.id}> Unplugged. Your battery is at **${batteryDisplay}**.`);
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
                    const channel: Channel | undefined = message.mentions.channels.first();
                    if (channel !== undefined) {
                        guildConfig.chargingChannel = channel.id;
                        message.channel.send(`<@${message.author.id}> Charging channel updated to <#${channel.id}>.`);
                        PS.save();
                    } else {
                        message.channel.send(`<@${message.author.id}> Missing channel parameter.`);
                    }
                } else if (configKey === "typeCWindowStartTime") {
                    guildConfig.typeCWindowStartTime = words[2];
                    message.channel.send(`<@${message.author.id}> 'Type C' window start time updated to ${words[2]}.`);
                    PS.save();
                } else if (configKey === "typeCWindowDurationMinutes") {
                    const windowDurationMinutes: number = parseInt(words[2], 10);
                    if (windowDurationMinutes >= 1 && windowDurationMinutes <= 1440) {
                        guildConfig.typeCWindowDurationMinutes = windowDurationMinutes;
                        message.channel.send(`<@${message.author.id}> 'Type C' window duration updated to ${windowDurationMinutes} minutes.`);
                        PS.save();
                    } else {
                        message.channel.send(`<@${message.author.id}> Value parameter should be a number of minutes between 1 and 1440.`);
                    }
                } else if (configKey === "typeCEntryDurationSeconds") {
                    const entryDurationSeconds: number = parseInt(words[2], 10);
                    if (entryDurationSeconds >= 1 && entryDurationSeconds <= 3600) {
                        guildConfig.typeCEntryDurationSeconds = entryDurationSeconds;
                        message.channel.send(`<@${message.author.id}> 'Type C' entry duration updated to ${entryDurationSeconds} seconds.`);
                        PS.save();
                    } else {
                        message.channel.send(`<@${message.author.id}> Value parameter should be a number of seconds between 1 and 3600.`);
                    }
                } else {
                    message.channel.send(`<@${message.author.id}> Unknown or unimplemented config key.`);
                }
            } else if (words.length === 2) {
                const key: string = words[1];
                if (guildConfig.hasOwnProperty(key)) {
                    let value: string = (guildConfig as any)[key];
                    if (key === "chargingChannel") {
                        value = "<#" + value + ">";
                    }
                    message.channel.send(`<@${message.author.id}> **${key}** is currently set to **${value}**.`);
                } else {
                    message.channel.send(`<@${message.author.id}> Unknown config key. Type **${config.prefix}config** by itself for help.`);
                }
            } else {
                message.channel.send(commands.config.helpDetails || '');
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
            "> **setNickname** - Set the bot's nickname",
        ].join("\n"),
        async run(message: MessageWithGuild): Promise<number> {
            const words: string[] = message.content.split(" ");
            interface AdminCommand {
                parameters?: string[];
                run: () => boolean | void;
            }
            const adminCommands: { [key: string]: AdminCommand } = {
                forceTypeC: {
                    run: (): void => {
                        postImage(message.guild.id);
                    },
                },
                rescheduleTypeC: {
                    run: (): void => {
                        schedulePost(message.guild.id, moment());
                    },
                },
                forceTallyEntries: {
                    run: (): boolean => {
                        const transientGuild: TransientGuildState = TS.guild(message.guild.id);
                        if (transientGuild.typeCTallyJob === null) {
                            message.channel.send(`<@${message.author.id}> No entry tallying job scheduled currently.`);
                            return false;
                        } else {
                            transientGuild.typeCTallyJob.invoke();
                            return true;
                        }
                    },
                },
                leaveVoice: {
                    run: (): void => {
                        //TODO integrate with @discordjs/voice
                        //message.guild.voice?.connection?.disconnect();
                    },
                },
                setNickname: {
                    parameters: ["nickname"],
                    run: (): void => {
                        message.guild.me?.setNickname(words[2]);
                    },
                },
            };
            if (words.length >= 2) {
                const command: string = words[1];
                if (adminCommands.hasOwnProperty(command)) {
                    const expectedParameterCount: number = adminCommands[command].parameters?.length ?? 0;
                    if (words.length === expectedParameterCount + 2) {
                        const result: boolean | void = adminCommands[command].run();
                        if (result !== false) {
                            message.channel.send(`<@${message.author.id}> Done.`);
                        }
                    } else {
                        message.channel.send(`<@${message.author.id}> Expected ${expectedParameterCount} parameter(s).`);
                    }
                } else {
                    message.channel.send(`<@${message.author.id}> Unknown admin command. Type **${config.prefix}admin** by itself for help.`);
                }
            } else {
                message.channel.send(commands.admin.helpDetails || '');
            }
            return 1;
        },
    },

    reverb: {
        batteryCost: 0.15,
        helpText: "Add reverb to your voice (or someone else's)",
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
        batteryCost: 0.25,
        helpText: "Repeat your voice (or someone else's) with a wobbly audio filter",
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
        helpText: "Repeat your voice (or someone else's) pitched up an octave",
        async run(message: MessageWithGuild): Promise<number> {
            return ffmpegAudioCommand("chipmunk", message, ((baseCommand: FfmpegCommand) => {
                baseCommand.on("start", console.log);
                return baseCommand.audioFilters(["asetrate=96000,aresample=48000,atempo=0.5"]);
            }));
        },
    },

    ow: {
        batteryCost: 0.3,
        helpText: "Play the 'ow' FX CHIP sound",
        async run(message: MessageWithGuild): Promise<number> {
            return soundClipCommand("ow", message, "resources/ow.wav");
        },
    },

    hey: {
        batteryCost: 0.1,
        helpText: "Play the 'hey' FX CHIP sound",
        async run(message: MessageWithGuild): Promise<number> {
            return soundClipCommand("hey", message, "resources/hey.wav");
        },
    },

    yeah: {
        batteryCost: 0.1,
        helpText: "Play the 'yeah' FX CHIP sound",
        async run(message: MessageWithGuild): Promise<number> {
            return soundClipCommand("yeah", message, "resources/yeah.wav");
        },
    },

    /*ronaldinho: {
        batteryCost: 0.64,
        scoreCost: 6.4,
        helpText: "Play the MUNDIAL RONALDINHO SOCCER 64 intro music",
        async run(message: MessageWithGuild): Promise<number> {
            return soundClipCommand("ronaldinho", message, "resources/MUNDIAL RONALDINHO SOCCER 64.wav");
        },
    },*/

};

type FfmpegCommandTransformer = ((inputCommand: FfmpegCommand) => FfmpegCommand);

async function soundClipCommand(
    commandName: string,
    message: MessageWithGuild,
    soundClip: string): Promise<number> {
    if (message.member?.voice.channel) {
        // TODO integrate with @discordjs/voice
        // const connection: VoiceConnection = await message.member.voice.channel?.join();
        // connection.play(soundClip, { volume: 0.5 })
        //     .on("start", () => {
        //         console.log(`${commandName} - start`);
        //     })
        //     .on("finish", () => {
        //         console.log(`${commandName} - finish`);
        //         connection.disconnect();
        //     });
        return 1;
    } else {
        message.channel.send(`<@${message.author.id}> You need to join a voice channel first!`);
        return 0;
    }
}

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
        return 0;
        // TODO integrate with @discordjs/voice
        // const member: GuildMember = maybeMember;
        // const connection: VoiceConnection = await maybeMember.voice.channel?.join();
        // return new Promise<number>((resolve): void => {
        // const audio: stream.Readable = connection.receiver.createStream(member, { mode: "pcm", end: "silence" });
        // const passThrough: stream.PassThrough = new stream.PassThrough();
        // const timeout: schedule.Job = schedule.scheduleJob(moment().add(10, "second").toDate(), () => {
        //     message.channel.send(`<@${message.author.id}> No audio received in 10 seconds - disconnecting.`);
        //     connection.disconnect();
        //     resolve(0.2); // minor penalty to discourage spamming
        // });
        // effect(ffmpeg().input(audio).inputFormat("s16le"))
        //     .format("s16le")
        //     .pipe(passThrough);
        // connection.play(passThrough, { type: "converted" })
        //     .on("start", () => {
        //         console.log(`${commandName} - start`);
        //         timeout.cancel();
        //         resolve(1);
        //     })
        //     .on("finish", () => {
        //         console.log(`${commandName} - finish`);
        //         connection.disconnect();
        //     });
        // });
    } else {
        if (maybeMember === message.member) {
            message.channel.send(`<@${message.author.id}> You need to join a voice channel first!`);
            return 0;
        } else {
            message.channel.send(`<@${message.author.id}> That user needs to join a voice channel first!`);
            return 0;
        }
    }
}

client.on("messageCreate", (incomingMessage) => {
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
            const scoreCost: number = command.scoreCost ?? 0;
            if (command.adminOnly && message.author.id !== config.adminUser) {
                message.channel.send(`<@${message.author.id}> This command is restricted to the bot's administrator.`);
                return;
            }
            const user: UserState = PS.user(message.guild.id, message.author.id);
            if (batteryCost <= user.battery && scoreCost <= user.chargingSpeed) {
                command.run(message).then((batteryCostWeight: number) => {
                    console.log(`batteryCostWeight = ${batteryCostWeight}`);
                    const batteryCostWeighted: number = batteryCostWeight * batteryCost;
                    const scoreCostWeighted: number = batteryCostWeight * scoreCost;
                    if (batteryCostWeighted > 0) {
                        user.battery = Math.max(0, user.battery - batteryCostWeighted);
                        user.chargingSpeed = Math.max(0, user.chargingSpeed - scoreCostWeighted);
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
                if (batteryCost >= user.battery) {
                    message.channel.send(`<@${message.author.id}> You don't have enough battery power! Charge your battery using the **${config.prefix}charge** command.`);
                } else {
                    message.channel.send(`<@${message.author.id}> Your charging speed isn't high enough! Follow the instructions on the image I post to increase your charging speed.`);
                }
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
}

function registerGuild(guild: Guild): void {
    const guildState: GuildState = PS.guild(guild.id);
    if (guildState.nextTypeCDate !== null) {
        const transientGuild: TransientGuildState = TS.guild(guild.id);
        if (transientGuild.nextTypeCJob !== null) {
            transientGuild.nextTypeCJob.cancel();
        }
        schedulePost(guild.id, moment(guildState.nextTypeCDate), { exactDateTime: true });
    } else {
        schedulePost(guild.id, moment());
    }
}

function postImage(guildId: Snowflake): void {
    const guildState: GuildState = PS.guild(guildId);
    const transientGuild: TransientGuildState = TS.guild(guildId);
    if (guildState.config.chargingChannel !== null) {
        const guild: Guild | null = client.guilds.resolve(guildId);
        if (guild !== null) {
            const channel: Channel | null = guild.channels.resolve(guildState.config.chargingChannel);
            if (channel instanceof TextChannel) {
                const typeCEvil: boolean = (Math.random() < config.typeCImageEvilChance);
                let typeCImage: string;
                if (typeCEvil) {
                    typeCImage = config.typeCImageEvil;
                } else {
                    typeCImage = guildState.config.typeCImageOverride || config.typeCImage;
                }
                channel.send({
                    files: [{
                        attachment: typeCImage,
                        name: 'typeC.jpg',
                    }],
                }).then((message: Message) => {
                    transientGuild.typeCPostStart = moment().toDate();
                    transientGuild.typeCPostEvil = typeCEvil;
                    transientGuild.typeCPostMessage = message;
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
        const guild: Guild | null = client.guilds.resolve(guildId);
        if (guild !== null) {
            const channel: Channel | null = guild.channels.resolve(guildState.config.chargingChannel);
            if (channel instanceof TextChannel) {
                if (transientGuild.typeCChargedUsers !== null) {
                    const chargedUserSet: Set<Snowflake> = new Set(transientGuild.typeCChargedUsers);
                    chargedUserSet.forEach((userId: Snowflake) => {
                        if (transientGuild.typeCPostEvil) {
                            PS.user(guildId, userId).chargingSpeed *= config.scoreEntryEvilMultiplier;
                        } else {
                            PS.user(guildId, userId).chargingSpeed += config.scoreEntryIncrement;
                        }
                    });
                    PS.save();
                    let messageTail: string;
                    if (transientGuild.typeCPostEvil) {
                        messageTail = "decreased their charging speed for some reason";
                    } else {
                        messageTail = "increased their charging speed";
                    }
                    if (chargedUserSet.size > 1) {
                        channel.send(`**${chargedUserSet.size} users** have ${messageTail}!`);
                    } else if (chargedUserSet.size === 1) {
                        channel.send(`**${chargedUserSet.size} user** has ${messageTail}!`);
                    } else {
                        if (transientGuild.typeCPostEvil) {
                            transientGuild.typeCPostMessage?.delete();
                        } else {
                            channel.send("No one wanted fast charging today...");
                        }
                    }
                    transientGuild.typeCPostStart = null;
                    transientGuild.typeCPostEvil = null;
                    transientGuild.typeCPostMessage = null;
                    transientGuild.typeCChargedUsers = null;
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

interface SchedulePostOptions {
    exactDateTime?: boolean;
}

function schedulePost(guildId: Snowflake, postDate: Moment, options?: SchedulePostOptions): void {
    const guild: GuildState = PS.guild(guildId);
    const transientGuild: TransientGuildState = TS.guild(guildId);
    if (guild.config.typeCWindowStartTime === null
        || guild.config.typeCWindowDurationMinutes === null
        || guild.config.typeCEntryDurationSeconds === null) {
        console.log(`Couldn't schedule Type C for guild ${guildId} because it's not fully configured`);
    } else {
        let postImageTime: Moment;
        if (options?.exactDateTime) {
            postImageTime = postDate;
        } else {
            const imageWindowStartTime: Moment = moment(guild.config.typeCWindowStartTime, "HH:mmZ");
            const imageWindowStartDateTime: Moment = postDate.set({
                hour: imageWindowStartTime.get("hour"),
                minute: imageWindowStartTime.get("minute"),
                second: 0,
                millisecond: 0,
            });
            const randomOffsetMinutes: number = Math.floor(Math.random() * guild.config.typeCWindowDurationMinutes);
            postImageTime = imageWindowStartDateTime.add(randomOffsetMinutes, "minutes");
        }

        if (postImageTime.isAfter(moment())) {
            guild.nextTypeCDate = postImageTime.toDate();
            if (transientGuild.nextTypeCJob !== null) {
                transientGuild.nextTypeCJob.cancel();
            }
            transientGuild.nextTypeCJob = schedule.scheduleJob(postImageTime.toDate(), () => { postImage(guildId); });
            console.log("Scheduled image post for " + postImageTime.toISOString());
            PS.save();
        } else {
            console.log(`Couldn't schedule image post for ${postImageTime.toISOString()} because it's in the past. Trying tomorrow...`);
            schedulePost(guildId, postDate.add(1, "day"));
        }
    }
}
