import { Snowflake } from "discord.js";
import fs from "fs";
import schedule from "node-schedule";

export class UserState {
    public battery: number = 1.0;
    public chargingSpeed: number = 3;
}

export class TransientUserState {
    public chargingJob: schedule.Job | null = null;
}

export class UsersState<T> {
    [key: string]: T; // userId
}

export class GuildConfigState {
    public chargingChannel: Snowflake | null = null; // channelId
    public typeCWindowStartTime: string | null = null;
    public typeCWindowDurationMinutes: number | null = null;
    public typeCEntryDurationSeconds: number | null = null;
    public prefixOverride: string | null = null;
    public typeCImageOverride: string | null = null;
    public typeCEntryMessageOverride: string | null = null;
    public scoreInitialOverride: number | null = null;
    public scoreEntryIncrementOverride: number | null = null;
    public scoreSuffixOverride: string | null = null;
}

export interface IGuildState<US> {
    users: UsersState<US>;
}

export class GuildState implements IGuildState<UserState> {
    public nextTypeCDate: Date | null = null;
    public config: GuildConfigState = new GuildConfigState();
    public users: UsersState<UserState> = new UsersState<UserState>();
}

export class TransientGuildState implements IGuildState<TransientUserState> {
    public typeCPostStart: Date | null = null;
    public typeCChargedUsers: Snowflake[] | null = null; // userId[]
    public nextTypeCJob: schedule.Job | null = null;
    public users: UsersState<TransientUserState> = new UsersState<TransientUserState>();
}

export class GuildsState<T> {
    [key: string]: T // guildId
}

export abstract class AppState<GS extends IGuildState<US>, US> {
    public guilds: GuildsState<GS> = {};

    public guild(guildId: Snowflake): GS {
        if (!(guildId in this.guilds)) {
            this.guilds[guildId] = this.defaultGuild();
        }
        return this.guilds[guildId];
    }

    public user(guildId: Snowflake, userId: Snowflake): US {
        const guild: GS = this.guild(guildId);
        if (!(userId in guild.users)) {
            guild.users[userId] = this.defaultUser();
        }
        return guild.users[userId];
    }

    protected abstract defaultGuild(): GS;
    protected abstract defaultUser(): US;
}

export class PersistentAppState extends AppState<GuildState, UserState> {
    constructor(public filename: string) {
        super();
        let data: string;
        try {
            data = fs.readFileSync(filename, {encoding: "utf-8", flag: "r"});
        } catch (err) {
            console.log(err);
            this.save();
            return;
        }
        console.log(JSON.parse(data));
        Object.assign(this, JSON.parse(data));
    }

    public save(): void {
        fs.writeFileSync(this.filename, JSON.stringify(this, undefined, 4), {encoding: "utf-8"});
    }

    protected defaultGuild(): GuildState {
        return new GuildState();
    }

    protected defaultUser(): UserState {
        return new UserState();
    }
}

export class TransientAppState extends AppState<TransientGuildState, TransientUserState> {
    protected defaultGuild(): TransientGuildState {
        return new TransientGuildState();
    }

    protected defaultUser(): TransientUserState {
        return new TransientUserState();
    }
}
