function normaliseScoreSheetPayload(rawPayload) {
    const payload = rawPayload || {};
    const source = payload.boxScore || payload.payload || payload;

    const awayTeam = toText(source.awayTeam, "Away Team");
    const homeTeam = toText(source.homeTeam, "Home Team");
    const homeBatsFirst = toBool(source.homeBatsFirst, false);

    return {
        dateOfGame: toText(source.dateOfGame, new Date().toISOString().slice(0, 10)),
        awayTeam,
        homeTeam,
        field: toText(source.field, "Unknown"),
        homeBatsFirst,
        umpire: toText(source.umpire, "TBC"),
        scoreByInning: {
            battingFirstTeam: toText(
                source?.scoreByInning?.battingFirstTeam,
                homeBatsFirst ? homeTeam : awayTeam
            ),
            battingSecondTeam: toText(
                source?.scoreByInning?.battingSecondTeam,
                homeBatsFirst ? awayTeam : homeTeam
            ),
            battingFirst: toInnings(source?.scoreByInning?.battingFirst),
            battingSecond: toInnings(source?.scoreByInning?.battingSecond)
        },
        gameDetails: {
            battingFirst: {
                homeRuns: toTextList(source?.gameDetails?.battingFirst?.homeRuns),
                sbhMvp: toText(source?.gameDetails?.battingFirst?.sbhMvp, "-"),
                bbhMvp: toText(source?.gameDetails?.battingFirst?.bbhMvp, "-")
            },
            battingSecond: {
                homeRuns: toTextList(source?.gameDetails?.battingSecond?.homeRuns),
                sbhMvp: toText(source?.gameDetails?.battingSecond?.sbhMvp, "-"),
                bbhMvp: toText(source?.gameDetails?.battingSecond?.bbhMvp, "-")
            }
        },
        notes: {
            otherPlayersAndPlays: toText(source?.notes?.otherPlayersAndPlays, "None provided."),
            seriousInjuries: toText(source?.notes?.seriousInjuries, "None reported."),
            incompleteReason: toText(source?.notes?.incompleteReason, "None provided.")
        }
    };
}

function toText(value, fallback = "") {
    if (value === undefined || value === null) {
        return fallback;
    }
    const trimmed = String(value).trim();
    return trimmed || fallback;
}

function toBool(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "y"].includes(normalized)) {
            return true;
        }
        if (["0", "false", "no", "n"].includes(normalized)) {
            return false;
        }
    }
    return fallback;
}

function toInnings(values) {
    const output = Array(10);//.fill(0);
    if (!Array.isArray(values)) {
        return output;
    }

    for (let i = 0; i < 10; i += 1) {
        if (values[i] == "") {
            output[i] = undefined;
        }
        else {
            const n = Number(values[i]);
            output[i] = Number.isFinite(n) ? n : undefined;
        }
    }

    return output;
}

function toTextList(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values.map((v) => toText(v)).filter(Boolean);
}

// function toNumber(value, fallback = 0) {
//     const n = Number(value);
//     return Number.isFinite(n) ? n : fallback;
// }

module.exports = {
    normaliseScoreSheetPayload
};