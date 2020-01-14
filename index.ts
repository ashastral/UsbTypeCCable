import { Client, GuildMember, Message, Guild, TextChannel, Attachment, Snowflake, Channel } from "discord.js";
import config from "./config.json";
import low from "lowdb";
import FileSync from "lowdb/adapters/FileSync";
import moment, { Moment } from "moment";
import schedule from "node-schedule";

type ScoreboardSchema = {
    [key: string]: { // memberId
        score: number
    }
};

const DefaultScoreboard: (() => ScoreboardSchema) = () => ({});

type GuildSchema = {
    chargingChannel: Snowflake | null, // channelId
    chargingImageStart: Date | null,
    chargedMembers: Snowflake[] | null, // memberId[]
    scoreboard: ScoreboardSchema
};

const DefaultGuild: (() => GuildSchema) = () => ({
    chargingChannel: null,
    chargingImageStart: null,
    chargedMembers: null,
    scoreboard: DefaultScoreboard()
});

type AppSchema = {
    guilds: {
        [key: string]: GuildSchema // guildId
    }
};

const DefaultApp: (() => AppSchema) = () => ({
    guilds: {}
});

const adapter: low.AdapterSync<AppSchema> = new FileSync<AppSchema>("db.json");
const db: low.LowdbSync<AppSchema> = low(adapter);

if (!db.has("guilds").value()) {
    db.defaults(DefaultApp()).write();
}

const client: Client = new Client();

client.once("ready", () => {
    client.guilds.forEach((guild: Guild, guildId: Snowflake) => {
        registerGuild(guild);
    });
    client.user.setActivity(`${config.prefix}help`, {type: "PLAYING"});
    console.log("Ready!");
});

client.on("guildCreate", registerGuild);

client.login(config.token);

type Command = {
    helpText: string,
    execute: (message: Message) => void
};

const commands: {[key: string]: Command} = {
    help: {
        helpText: "View this information",
        execute: function(message: Message): void {
            var allHelpText: string[] = [];
            Object.entries(commands).forEach(([commandName, command]: [string, Command]) => {
                allHelpText.push(`${config.prefix}${commandName} - ${command.helpText}`);
            });
            message.channel.send(allHelpText.join("\n"));
        }
    },

    scoreboard: {
        helpText: "View the charging speed scoreboard for this server",
        execute: function(message: Message): void {
            var scoreboard: ScoreboardSchema = db.get("guilds")
                .get(message.guild.id)
                .get("scoreboard", {})
                .value();
            type MemberScore = {memberId: Snowflake, score: number};
            var scoreArray: MemberScore[] = Object.keys(scoreboard)
                .map((memberId: Snowflake) => ({
                    memberId: memberId,
                    score: scoreboard[memberId].score
                }));
            scoreArray.sort(memberScore => memberScore.score);
            var scoreMessageArray: string[] = [];
            scoreArray.forEach(memberScore => {
                var member: GuildMember | undefined = message.guild.members.get(memberScore.memberId);
                var memberDisplayName: string = (member === undefined) ? memberScore.memberId.toString() : member.displayName;
                scoreMessageArray.push("**" + memberDisplayName + "**: " + memberScore.score + "W");
            });
            message.channel.send("Scoreboard:\n" + scoreMessageArray.join("\n"));
        }
    },

    score: {
        helpText: "View your charging speed",
        execute: function(message: Message): void {
            var score: number = db.get("guilds")
                .get(message.guild.id)
                .get("scoreboard")
                .get(message.member.id)
                .get("score", config.scoreInitial)
                .value();
            message.channel.send(`<@${message.member.id}> Your score is **${score}${config.scoreSuffix}**.`);
        }
    },

    setChargingChannel: {
        helpText: "Set the channel for charging to the channel where the command was sent",
        execute: function(message: Message): void {
            db.get("guilds")
                .get(message.guild.id)
                .set("chargingChannel", message.channel.id)
                .write();
            message.channel.send(`Charging channel updated to <#${message.channel.id}>.`);
        }
    },

    forcePostImage: {
        helpText: "Force-post image",
        execute: function(message: Message): void {
            postImage();
        }
    }
};

client.on("message", message => {
    if (message.content.startsWith(config.prefix)) {
        var afterPrefix: string = message.content.slice(1);
        if (commands.hasOwnProperty(afterPrefix)) {
            commands[afterPrefix].execute(message);
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
                        .get("chargedMembers")
                        .push(message.member.id)
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
                    channel.send(new Attachment(config.image)).then(() => {
                        db.get("guilds")
                            .get(guildId)
                            .assign({
                                chargingImageStart: moment().toDate(),
                                chargedMembers: []
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
                    if (schema.chargedMembers !== null) {
                        var chargedMemberset: Set<Snowflake> = new Set(schema.chargedMembers);
                        chargedMemberset.forEach((memberId: Snowflake) => {
                            db.get("guilds")
                                .get(guildId)
                                .get("scoreboard")
                                .defaults({[memberId]: {score: config.scoreInitial}})
                                .get(memberId)
                                .update("score", (score: number) => score + config.scoreEntryIncrement)
                                .write();
                        });
                        if (chargedMemberset.size > 1) {
                            channel.send(`**${chargedMemberset.size} users** have increased their charging speed!`);
                        } else if (chargedMemberset.size === 1) {
                            channel.send(`**${chargedMemberset.size} user** has increased their charging speed!`);
                        } else {
                            channel.send("No one wanted fast charging today...");
                        }
                        db.get("guilds")
                            .get(guildId)
                            .assign({
                                chargingImageStart: null,
                                chargedMembers: null
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
        "millisecond": 0
    });
    var randomOffsetMinutes: number = Math.floor(Math.random() * config.imageWindowDurationMinutes);
    var postImageTime: Moment = imageWindowStartDateTime.add(randomOffsetMinutes, "minutes");

    if (postImageTime.isAfter(moment())) {
        console.log("Scheduled image post for " + postImageTime.toISOString());
        schedule.scheduleJob(postImageTime.toDate(), postImage);
    } else {
        schedulePost(postDate.add(1, "day"));
    }
}

schedulePost(moment());