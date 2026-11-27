require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ElvQrScanner'
  s.version        = package['version']
  s.summary        = 'ELV IPTV native in-app QR code camera scanner for iOS and iPadOS'
  s.license        = { :type => 'Proprietary', :text => 'Copyright (c) ELV IPTV. All rights reserved.' }
  s.author         = 'ELV IPTV'
  s.homepage       = 'https://github.com/fatihmutluu/elv-iptv'
  s.platforms      = { :ios => '18.0', :tvos => '18.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.ios.frameworks = ['AVFoundation', 'UIKit']

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=appletvsimulator*]' => 'x86_64',
    'SWIFT_STRICT_CONCURRENCY' => 'targeted',
  }

  s.source_files = '**/*.swift'
end
