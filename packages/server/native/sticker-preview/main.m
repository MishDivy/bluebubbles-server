#import "StickerPreview.h"
#include <stdio.h>
#include <sys/resource.h>

static int Reply(NSDictionary *reply, int status) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
    if (!json) return 1;
    fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); return status;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // The caller also enforces a ten-second wall deadline with SIGKILL.
        struct rlimit cpu = {10, 10};
        if (setrlimit(RLIMIT_CPU, &cpu)) return Reply(@{@"version": @1, @"ok": @NO, @"error": @"conversion_failed"}, 1);
        NSString *error = @"invalid_arguments";
        @try {
            if (argc == 3) {
                NSString *input = [NSString stringWithUTF8String:argv[1]], *output = [NSString stringWithUTF8String:argv[2]];
                if (SPPath(input) && SPPath(output) && ![input isEqual:output]) {
                    NSData *bytes = SPRead(input, &error);
                    NSDictionary *result = nil;
                    NSData *converted = bytes ? SPConvert(bytes, &result, &error) : nil;
                    if (converted) {
                        if (SPPublish(converted, output)) return Reply(result, 0);
                        error = @"output_unavailable";
                    }
                }
            }
        } @catch (NSException *exception) {
            (void)exception; error = @"conversion_failed";
        }
        return Reply(@{@"version": @1, @"ok": @NO, @"error": error ?: @"conversion_failed"}, 1);
    }
}
