require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'ElvXmltvNative'
  s.version          = package['version']
  s.summary          = 'ELV IPTV native streaming XMLTV parser and SQLite stager'
  s.license          = { :type => 'Proprietary', :text => 'Copyright (c) ELV IPTV. All rights reserved.' }
  s.author           = 'ELV IPTV'
  s.homepage         = 'https://github.com/fatihmutluu/elv-iptv'
  s.platforms        = { :ios => '18.0', :tvos => '18.0' }
  s.swift_version    = '5.9'
  s.source           = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.libraries = ['sqlite3', 'z']

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=appletvsimulator*]' => 'x86_64',
    'SWIFT_STRICT_CONCURRENCY' => 'targeted',
  }

  s.source_files = 'Core/**/*.swift', 'ElvXmltvNativeModule.swift'
end
