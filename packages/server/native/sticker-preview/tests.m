#import "StickerPreview.h"
#include <assert.h>
#include <stdio.h>

static CGImageRef Frame(NSUInteger width, NSUInteger height, BOOL alpha, NSUInteger variant) {
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, color,
        alpha ? kCGImageAlphaPremultipliedLast : kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(color); assert(context);
    CGContextSetRGBFillColor(context, variant ? 0.25 : 0.75, 0.5, 0.25, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    if (alpha) {
        CGContextClearRect(context, CGRectMake(0, 0, width / 2, height));
        CGContextSetBlendMode(context, kCGBlendModeCopy);
        CGContextSetRGBFillColor(context, 0.25, 0.5, 0.75, 0.5);
        CGContextFillRect(context, CGRectMake(width / 2, 0, width / 2, height / 2));
    }
    CGImageRef image = CGBitmapContextCreateImage(context); CGContextRelease(context); assert(image); return image;
}

static NSData *Encode(NSString *type, NSUInteger count, BOOL alpha, NSUInteger width, NSUInteger height, NSUInteger orientation) {
    NSMutableData *data = [NSMutableData new];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, (__bridge CFStringRef)type, count, NULL);
    if (!destination) return nil;
    BOOL sequence = [type isEqual:@"public.heics"], png = [type isEqual:@"public.png"];
    if (count > 1) CGImageDestinationSetProperties(destination, (__bridge CFDictionaryRef)@{
        (sequence ? (NSString *)kCGImagePropertyHEICSDictionary : (NSString *)kCGImagePropertyPNGDictionary):
            @{(sequence ? (NSString *)kCGImagePropertyHEICSLoopCount : (NSString *)kCGImagePropertyAPNGLoopCount): @2}});
    for (NSUInteger index = 0; index < count; index++) {
        CGImageRef image = Frame(width, height, alpha, index % 2);
        NSMutableDictionary *properties = [@{(NSString *)kCGImagePropertyOrientation: @(orientation),
            (NSString *)kCGImageDestinationLossyCompressionQuality: @1} mutableCopy];
        if (count > 1) properties[sequence ? (NSString *)kCGImagePropertyHEICSDictionary : (NSString *)kCGImagePropertyPNGDictionary] = @{
            (sequence ? (NSString *)kCGImagePropertyHEICSDelayTime : (NSString *)kCGImagePropertyAPNGDelayTime): (index ? @0.25 : @0.1),
            (sequence ? (NSString *)kCGImagePropertyHEICSUnclampedDelayTime : (NSString *)kCGImagePropertyAPNGUnclampedDelayTime): (index ? @0.25 : @0.1)};
        if (png && count == 1) properties[(NSString *)kCGImagePropertyHasAlpha] = @(alpha);
        CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties); CGImageRelease(image);
    }
    BOOL success = CGImageDestinationFinalize(destination); CFRelease(destination); return success ? data : nil;
}

static BOOL DecodesAlpha(NSData *data) {
    CGImageSourceRef source = data ? CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL) : NULL;
    if (!source) return NO;
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    BOOL alpha = image && SPHasAlpha(image); if (image) CGImageRelease(image); CFRelease(source); return alpha;
}

static void Write(NSData *data, NSString *path) {
    int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    assert(fd >= 0 && write(fd, data.bytes, data.length) == (ssize_t)data.length && !close(fd));
}

static NSDictionary *Run(NSString *executable, NSArray *arguments, int *status) {
    NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:executable]; task.arguments = arguments;
    NSPipe *pipe = [NSPipe pipe]; task.standardOutput = pipe; task.standardError = NSFileHandle.fileHandleWithNullDevice;
    assert([task launchAndReturnError:NULL]);
    NSData *bytes = [pipe.fileHandleForReading readDataToEndOfFile]; [task waitUntilExit];
    assert(bytes.length < 8192); if (status) *status = task.terminationStatus;
    NSDictionary *reply = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
    assert([reply isKindOfClass:NSDictionary.class] && [reply[@"version"] isEqual:@1]); return reply;
}

static NSDictionary *RasterContainer(NSArray *auxiliary) {
    return @{(NSString *)kCGImagePropertyFileContentsDictionary: @{
        (NSString *)kCGImagePropertyImageCount: @1,
        (NSString *)kCGImagePropertyImages: @[@{(NSString *)kCGImagePropertyAuxiliaryData: auxiliary}]}};
}

static void TestRasterAuxiliary(void) {
    NSDictionary *frame = @{(NSString *)kCGImagePropertyPixelWidth: @64, (NSString *)kCGImagePropertyPixelHeight: @96,
        (NSString *)kCGImagePropertyOrientation: @1, (NSString *)kCGImagePropertyHasAlpha: @YES};
    NSDictionary *plane = @{(NSString *)kCGImagePropertyWidth: @64, (NSString *)kCGImagePropertyHeight: @96,
        (NSString *)kCGImagePropertyOrientation: @1, (NSString *)kCGImagePropertyPixelFormat: @(kCVPixelFormatType_OneComponent8)};
    NSDictionary *container = RasterContainer(@[plane]); BOOL alpha = NO;
    assert(!SPContainerAuxiliaryAllowed(container, &alpha));
    assert(SPStaticRasterAuxiliaryAllowed(container, frame, @"public.heic", 1, 0, &alpha) && alpha);
    assert(!SPStaticRasterAuxiliaryAllowed(container, frame, @"public.heic", 2, 0, NULL));
    assert(!SPStaticRasterAuxiliaryAllowed(container, frame, @"public.heic", 1, 1, NULL));
    for (NSString *type in @[@"public.heics", @"public.png"])
        assert(!SPStaticRasterAuxiliaryAllowed(container, frame, type, 1, 0, NULL));
    for (id value in @[@NO, @1, NSNull.null]) {
        NSMutableDictionary *changed = [frame mutableCopy]; changed[(NSString *)kCGImagePropertyHasAlpha] = value;
        assert(!SPStaticRasterAuxiliaryAllowed(container, changed, @"public.heic", 1, 0, NULL));
    }
    for (NSString *key in frame) {
        NSMutableDictionary *changed = [frame mutableCopy]; [changed removeObjectForKey:key];
        assert(!SPStaticRasterAuxiliaryAllowed(container, changed, @"public.heic", 1, 0, NULL));
    }
    for (NSString *key in plane) {
        NSMutableDictionary *changed = [plane mutableCopy]; [changed removeObjectForKey:key];
        assert(!SPStaticRasterAuxiliaryAllowed(RasterContainer(@[changed]), frame, @"public.heic", 1, 0, NULL));
        for (NSNumber *value in @[@0, @YES, @619, @6]) {
            changed = [plane mutableCopy]; changed[key] = value;
            assert(!SPStaticRasterAuxiliaryAllowed(RasterContainer(@[changed]), frame, @"public.heic", 1, 0, NULL));
        }
    }
    for (NSString *key in @[@"Reference", (NSString *)kCGImagePropertyAuxiliaryDataType]) {
        NSMutableDictionary *changed = [plane mutableCopy]; changed[key] = @"unknown";
        assert(!SPStaticRasterAuxiliaryAllowed(RasterContainer(@[changed]), frame, @"public.heic", 1, 0, NULL));
    }
    for (NSArray *planes in @[@[], @[plane, plane]])
        assert(!SPStaticRasterAuxiliaryAllowed(RasterContainer(planes), frame, @"public.heic", 1, 0, NULL));
    for (NSString *key in @[(NSString *)kCGImagePropertyHEICSDictionary, (NSString *)kCGImagePropertyAuxiliaryData]) {
        NSMutableDictionary *changed = [container mutableCopy];
        changed[key] = [key isEqual:(NSString *)kCGImagePropertyHEICSDictionary] ? (id)@{} : (id)@[@{}];
        assert(!SPStaticRasterAuxiliaryAllowed(changed, frame, @"public.heic", 1, 0, NULL));
    }
    NSMutableDictionary *changedFrame = [frame mutableCopy]; changedFrame[(NSString *)kCGImagePropertyOrientation] = @6;
    assert(!SPStaticRasterAuxiliaryAllowed(container, changedFrame, @"public.heic", 1, 0, NULL));
    changedFrame = [frame mutableCopy]; changedFrame[(NSString *)kCGImagePropertyAuxiliaryData] = @[@{}];
    assert(!SPStaticRasterAuxiliaryAllowed(container, changedFrame, @"public.heic", 1, 0, NULL));
    NSMutableDictionary *contents = [container[(NSString *)kCGImagePropertyFileContentsDictionary] mutableCopy];
    contents[(NSString *)kCGImagePropertyImageCount] = @2;
    assert(!SPStaticRasterAuxiliaryAllowed(@{(NSString *)kCGImagePropertyFileContentsDictionary: contents}, frame, @"public.heic", 1, 0, NULL));
    contents[(NSString *)kCGImagePropertyImageCount] = @1;
    contents[(NSString *)kCGImagePropertyImages] = @[container[(NSString *)kCGImagePropertyFileContentsDictionary][(NSString *)kCGImagePropertyImages][0], @{}];
    assert(!SPStaticRasterAuxiliaryAllowed(@{(NSString *)kCGImagePropertyFileContentsDictionary: contents}, frame, @"public.heic", 1, 0, NULL));
    puts("PASS raster-only untyped auxiliary gate and rejected format/dimension/orientation/alpha/shape/sequence variants.");
}

static void TestHEICS(BOOL alpha) {
    NSData *heics = Encode(@"public.heics", 2, alpha, 64, 96, 1);
    if (!heics) {
        puts(alpha ? "SKIP alpha HEICS encoder unavailable; no alpha-animation acceptance claimed."
                   : "SKIP opaque HEICS encoder unavailable; separate APNG timing/order and strict metadata tests still run.");
        return;
    }
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)heics, NULL); assert(source);
    NSDictionary *container = CFBridgingRelease(CGImageSourceCopyProperties(source, NULL));
    NSMutableArray *frames = [NSMutableArray new]; BOOL requiresAlpha = NO, auxiliaryAllowed = SPContainerAuxiliaryAllowed(container, &requiresAlpha);
    for (NSUInteger index = 0; index < CGImageSourceGetCount(source); index++) {
        NSDictionary *frame = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, index, NULL));
        assert(frame); [frames addObject:frame]; auxiliaryAllowed &= SPAuxiliaryAllowed(frame, &requiresAlpha);
    }
    NSNumber *loop = nil; NSArray *delays = SPSequenceTiming(container, frames, 2, &loop); CFRelease(source);
    NSDictionary *result = nil; NSString *error = nil; NSData *preview = SPConvert(heics, &result, &error);
    if (!auxiliaryAllowed) {
        assert(!preview && [error isEqual:@"unsupported_auxiliary"]);
        puts(alpha ? "SKIP alpha HEICS acceptance: unknown animated auxiliary explicitly rejected, never flattened."
                   : "SKIP opaque HEICS acceptance: encoder emitted unsupported auxiliary; explicit rejection verified.");
    } else if (frames.count == 2 && delays) {
        assert(preview && !error && [result[@"format"] isEqual:@"apng"] && [result[@"frames"] isEqual:@2]);
        if (alpha && DecodesAlpha(heics)) assert([result[@"hasAlpha"] isEqual:@YES] && DecodesAlpha(preview));
        puts(alpha && DecodesAlpha(heics) ? "PASS alpha HEICS-to-APNG pixel/alpha, frame order, finite loop and timing roundtrip."
             : alpha ? "SKIP alpha HEICS: encoder omitted alpha; timed raster roundtrip passed without alpha claim."
                     : "PASS opaque HEICS-to-APNG frame order, pixels, finite loop and timing roundtrip.");
    } else {
        assert(!preview && [error isEqual:@"unsupported_animation"]);
        puts(alpha ? "SKIP alpha HEICS: incomplete animation metadata explicitly rejected."
                   : "SKIP opaque HEICS: incomplete animation metadata explicitly rejected, never flattened.");
    }
}

int main(int argc, const char *argv[]) {
    assert(argc == 2);
    @autoreleasepool {
        NSString *executable = [NSString stringWithUTF8String:argv[1]];
        assert(!SPPath(@"/tmp/../private/source") && !SPPath(@"/private//tmp/source") && !SPPath(@"relative"));
        assert(!SPInteger(@YES, 10) && !SPInteger(@0.5, 10) && !SPNumber(@(NAN)) && !SPNumber(@(INFINITY)));
        NSDictionary *small = @{(NSString *)kCGImagePropertyPixelWidth: @2, (NSString *)kCGImagePropertyPixelHeight: @2};
        NSDictionary *large = @{(NSString *)kCGImagePropertyPixelWidth: @618, (NSString *)kCGImagePropertyPixelHeight: @618};
        BOOL alpha = NO; NSString *error = nil;
        assert(SPFramePropertiesValid(@[small], &alpha, &error));
        NSMutableArray *frames = [NSMutableArray new];
        for (NSUInteger index = 0; index < 100; index++) [frames addObject:small];
        assert(SPFramePropertiesValid(frames, &alpha, &error)); [frames addObject:small];
        assert(!SPFramePropertiesValid(frames, &alpha, &error) && [error isEqual:@"image_limits"]);
        [frames removeAllObjects];
        for (NSUInteger index = 0; index < 65; index++) [frames addObject:large];
        assert(SPFramePropertiesValid(frames, &alpha, &error)); [frames addObject:large];
        assert(!SPFramePropertiesValid(frames, &alpha, &error));
        assert(!SPFramePropertiesValid(@[@{(NSString *)kCGImagePropertyPixelWidth: @619, (NSString *)kCGImagePropertyPixelHeight: @2}], &alpha, &error));
        assert(!SPFramePropertiesValid(@[@{(NSString *)kCGImagePropertyPixelWidth: @0, (NSString *)kCGImagePropertyPixelHeight: @2}], &alpha, &error));
        NSDictionary *aux = @{(NSString *)kCGImagePropertyAuxiliaryData: @[@{(NSString *)kCGImagePropertyAuxiliaryDataType: @"unknown-effect"}]};
        assert(!SPAuxiliaryAllowed(aux, &alpha));
        assert(!SPContainerAuxiliaryAllowed(@{(NSString *)kCGImagePropertyFileContentsDictionary:
            @{(NSString *)kCGImagePropertyImages: @[aux]}}, &alpha));
        assert(SPAuxiliaryAllowed(@{(NSString *)kCGImagePropertyAuxiliaryData:
            @[@{(NSString *)kCGImagePropertyAuxiliaryDataType: @"urn:mpeg:hevc:2015:auxid:1"}]}, &alpha) && alpha);
        TestRasterAuxiliary();
        NSArray *timing = @[@{(NSString *)kCGImagePropertyHEICSUnclampedDelayTime: @0.1},
                           @{(NSString *)kCGImagePropertyHEICSDelayTime: @0.25}];
        NSDictionary *sequence = @{(NSString *)kCGImagePropertyHEICSDictionary: @{
            (NSString *)kCGImagePropertyHEICSLoopCount: @2, (NSString *)kCGImagePropertyHEICSFrameInfoArray: timing}};
        NSNumber *loop = nil;
        assert([SPSequenceTiming(sequence, @[small, small], 2, &loop) isEqual:@[@0.1, @0.25]] && [loop isEqual:@2]);
        NSMutableDictionary *badSequence = [sequence[(NSString *)kCGImagePropertyHEICSDictionary] mutableCopy];
        [badSequence removeObjectForKey:(NSString *)kCGImagePropertyHEICSLoopCount];
        assert(!SPSequenceTiming(@{(NSString *)kCGImagePropertyHEICSDictionary: badSequence}, @[small, small], 2, &loop));
        badSequence[(NSString *)kCGImagePropertyHEICSLoopCount] = @YES;
        assert(!SPSequenceTiming(@{(NSString *)kCGImagePropertyHEICSDictionary: badSequence}, @[small, small], 2, &loop));
        badSequence[(NSString *)kCGImagePropertyHEICSLoopCount] = @2;
        badSequence[(NSString *)kCGImagePropertyHEICSFrameInfoArray] = @[@{(NSString *)kCGImagePropertyHEICSDelayTime: @0}, timing[1]];
        assert(!SPSequenceTiming(@{(NSString *)kCGImagePropertyHEICSDictionary: badSequence}, @[small, small], 2, &loop));
        SPBoundedSink *sink = [SPBoundedSink new]; sink.data = [NSMutableData new]; sink.limit = 2;
        assert(SPPutBytes((__bridge void *)sink, "12", 2) == 2 && SPPutBytes((__bridge void *)sink, "3", 1) == 0 && sink.overflow && sink.data.length == 2);
        NSData *apng = Encode(@"public.png", 2, YES, 4, 2, 1); assert(apng && DecodesAlpha(apng));
        CGImageSourceRef apngSource = CGImageSourceCreateWithData((__bridge CFDataRef)apng, NULL);
        assert(apngSource && CGImageSourceGetCount(apngSource) == 2);
        NSDictionary *apngProperties = CFBridgingRelease(CGImageSourceCopyProperties(apngSource, NULL));
        assert([apngProperties[(NSString *)kCGImagePropertyPNGDictionary][(NSString *)kCGImagePropertyAPNGLoopCount] isEqual:@2]);
        for (NSUInteger index = 0; index < 2; index++) {
            CGImageRef original = Frame(4, 2, YES, index), decoded = CGImageSourceCreateImageAtIndex(apngSource, index, NULL);
            assert(decoded && [SPPixels(original) isEqual:SPPixels(decoded)]);
            NSDictionary *frame = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(apngSource, index, NULL));
            double delay = [frame[(NSString *)kCGImagePropertyPNGDictionary][(NSString *)kCGImagePropertyAPNGUnclampedDelayTime] doubleValue];
            if (!delay) delay = [frame[(NSString *)kCGImagePropertyPNGDictionary][(NSString *)kCGImagePropertyAPNGDelayTime] doubleValue];
            assert(fabs(delay - (index ? 0.25 : 0.1)) < 0.000001);
            CGImageRelease(original); CGImageRelease(decoded);
        }
        CFRelease(apngSource);
        NSDictionary *result = nil;
        assert(!SPConvert(apng, &result, &error) && [error isEqual:@"unsupported_type"] && !result);

        char directory[] = "/private/tmp/bb-sticker-preview-fixtures.XXXXXX";
        assert(mkdtemp(directory)); NSString *root = [NSString stringWithUTF8String:directory];
        NSString *input = [root stringByAppendingPathComponent:@"input.heic"], *output = [root stringByAppendingPathComponent:@"preview.png"];
        Write(apng, input); assert([SPRead(input, &error) isEqual:apng]);
        NSString *link = [root stringByAppendingPathComponent:@"link"];
        assert(!symlink(input.fileSystemRepresentation, link.fileSystemRepresentation));
        assert(!SPRead(link, &error)); assert(!unlink(link.fileSystemRepresentation));
        assert(!symlink(root.fileSystemRepresentation, link.fileSystemRepresentation));
        assert(!SPRead([link stringByAppendingPathComponent:@"input.heic"], &error)); assert(!unlink(link.fileSystemRepresentation));
        int status = 0;
        NSDictionary *reply = Run(executable, @[], &status);
        assert(status != 0 && [reply[@"ok"] isEqual:@NO] && [reply[@"error"] isEqual:@"invalid_arguments"]);
        reply = Run(executable, @[input, output], &status);
        assert(status != 0 && [reply[@"error"] isEqual:@"unsupported_type"] && ![NSFileManager.defaultManager fileExistsAtPath:output]);
        assert([SPRead(input, &error) isEqual:apng]);
        NSString *partial = [root stringByAppendingPathComponent:@".bb-sticker-preview.partial"];
        Write(apng, partial); assert(!SPPublish(apng, output));
        assert([SPRead(partial, &error) isEqual:apng]); assert(!unlink(partial.fileSystemRepresentation));
        assert(SPPublish(apng, output) && !SPPublish(apng, output));
        assert([SPRead(output, &error) isEqual:apng]);
        struct stat mode; assert(!stat(output.fileSystemRepresentation, &mode) && (mode.st_mode & 0777) == 0600);
        assert(!unlink(output.fileSystemRepresentation));
        assert(!symlink(input.fileSystemRepresentation, output.fileSystemRepresentation));
        assert(!SPPublish(apng, output) && [SPRead(input, &error) isEqual:apng]); assert(!unlink(output.fileSystemRepresentation));
        assert(!chmod(root.fileSystemRepresentation, 0755)); assert(!SPPublish(apng, output)); assert(!chmod(root.fileSystemRepresentation, 0700));
        NSString *oversized = [root stringByAppendingPathComponent:@"oversized.heic"];
        int fd = open(oversized.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL, 0600);
        assert(fd >= 0 && !ftruncate(fd, SPMaxInputBytes + 1) && !close(fd));
        assert(!SPRead(oversized, &error) && [error isEqual:@"input_too_large"]); assert(!unlink(oversized.fileSystemRepresentation));
        assert(!unlink(input.fileSystemRepresentation));
        NSData *heic = Encode(@"public.heic", 1, NO, 64, 96, 1);
        if (heic) {
            NSData *preview = SPConvert(heic, &result, &error);
            assert(preview && !error && [result[@"format"] isEqual:@"png"] && [result[@"frames"] isEqual:@1]);
            Write(heic, input); reply = Run(executable, @[input, output], &status);
            assert(status == 0 && [reply[@"ok"] isEqual:@YES] && [SPRead(input, &error) isEqual:heic]);
            assert([SPRead(output, &error) isEqual:preview]); assert(!unlink(input.fileSystemRepresentation)); assert(!unlink(output.fileSystemRepresentation));
            NSData *tooWide = Encode(@"public.heic", 1, NO, 619, 64, 1); assert(tooWide);
            assert(!SPConvert(tooWide, &result, &error) && [error isEqual:@"image_limits"]);
            NSData *oriented = Encode(@"public.heic", 1, NO, 64, 96, 6); assert(oriented);
            assert(SPConvert(oriented, &result, &error) && [result[@"width"] isEqual:@96] && [result[@"height"] isEqual:@64]);
            puts("PASS static HEIC conversion, original bytes, dimensions, orientation, CLI protocol.");
        } else puts("SKIP static HEIC: this runner cannot encode the synthetic HEIC fixture; native acceptance remains unverified.");
        NSData *transparent = Encode(@"public.heic", 1, YES, 64, 96, 1);
        if (transparent && DecodesAlpha(transparent)) {
            NSData *preview = SPConvert(transparent, &result, &error);
            assert(preview && !error && [result[@"hasAlpha"] isEqual:@YES] && DecodesAlpha(preview));
            puts("PASS alpha-bearing HEIC-to-PNG pixel roundtrip.");
        } else puts("SKIP HEIC alpha: the fixture encoder/decoder does not expose an alpha-bearing HEIC; original fallback remains required.");
        TestHEICS(NO); TestHEICS(YES);
        assert([NSFileManager.defaultManager contentsOfDirectoryAtPath:root error:NULL].count == 0);
        assert(!rmdir(root.fileSystemRepresentation));
        puts("PASS always-run bounds, unknown auxiliary rejection, timing validation, APNG alpha/timing/order, exclusive publication, no-follow reads and fixed errors.");
    }
    return 0;
}
